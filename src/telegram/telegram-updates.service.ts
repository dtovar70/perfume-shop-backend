import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    type OnModuleInit,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { InlineKeyboard, type Context } from 'grammy'
import type { Message } from 'grammy/types'
import { DataSource } from 'typeorm'
import { OrderStatusCatalogService } from '../catalogs/order-status-catalog.service.js'
import { ORDER_LIMITS } from '../orders/dto/field-names.js'
import { OrderPayment } from '../orders/entities/order-payment.entity.js'
import { Order } from '../orders/entities/order.entity.js'
import type { StockConflictLine } from '../orders/entities/order.entity.js'
import type { OrderActor } from '../orders/order-status.js'
import {
    OrderStatusService,
    STOCK_CONFLICT_UNACKNOWLEDGED,
} from '../orders/order-status.service.js'
import type { TelegramChat } from './entities/telegram-chat.entity.js'
import { SlidingWindowLimiter } from './rate-limiter.js'
import {
    encodeCallback,
    parseCallback,
    REJECT_REASONS,
    type CallbackAction,
} from './telegram-callbacks.js'
import { TelegramBotService } from './telegram-bot.service.js'
import {
    accountMessage,
    escapeHtml,
    formatCaracasTime,
    HELP_TEXT,
    orderSummaryMessage,
    PRIVATE_BOT_MESSAGE,
    stockLinesText,
    truncate,
    WELCOME_MESSAGE,
} from './telegram-format.js'
import {
    isButtonUrl,
    TelegramPaymentsService,
    type PaymentContext,
} from './telegram-payments.service.js'
import {
    linkedByInactiveUser,
    TelegramStoreService,
    type TelegramSender,
} from './telegram-store.service.js'

/** How long "Otro motivo…" waits for the typed reason. */
export const REASON_TTL_MS = 10 * 60_000
const PENDING_LIST_LIMIT = 10

interface PendingReason {
    paymentId: string
    promptMessageId: number
    expiresAt: number
}

/** "KZ-000012", "kz-12", "12" -> "KZ-000012"; null when it is not an order code. */
export function normalizeOrderCode(value: string): string | null {
    const match = /^(?:KZ-?)?(\d{1,9})$/i.exec(value.trim())
    return match ? `KZ-${(match[1] as string).padStart(6, '0')}` : null
}

/** How the owner is named in the messages: Telegram first name, @username or the admin. */
export function chatDisplayName(chat: TelegramChat): string {
    return (
        chat.firstName ??
        (chat.username ? `@${chat.username}` : null) ??
        chat.linkedBy?.name ??
        'Telegram'
    )
}

function sender(ctx: Context): TelegramSender | null {
    if (!ctx.chat) return null
    return {
        chatId: String(ctx.chat.id),
        username: ctx.from?.username ?? null,
        firstName: ctx.from?.first_name ?? null,
    }
}

/**
 * Everything the bot answers: linking (`/start <code>`), commands and the payment buttons. Only
 * private chats are served. An unlinked chat only ever gets the "private bot" reply: no order
 * data, no actions. Every action re-checks the payment in the database and goes through
 * `OrderStatusService.transition()`, so the web and the bot can never disagree.
 */
@Injectable()
export class TelegramUpdatesService implements OnModuleInit {
    private readonly logger = new Logger('TelegramUpdates')
    /** Bot actions per chat: 30 per minute. */
    private readonly actionLimiter = new SlidingWindowLimiter(30, 60_000)
    /** Link attempts per chat (5 per 10 minutes) and wrong codes overall (30 per 10 minutes). */
    private readonly linkLimiter = new SlidingWindowLimiter(5, 10 * 60_000)
    private readonly wrongCodeLimiter = new SlidingWindowLimiter(30, 10 * 60_000)
    /** Payments being confirmed or rejected right now (double taps). */
    private readonly inFlight = new Set<string>()
    /** "Otro motivo…": the chat's next text is the reason. */
    private readonly pendingReasons = new Map<string, PendingReason>()

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly telegram: TelegramBotService,
        private readonly store: TelegramStoreService,
        private readonly payments: TelegramPaymentsService,
        private readonly statuses: OrderStatusService,
        private readonly catalog: OrderStatusCatalogService,
    ) {}

    onModuleInit(): void {
        const bot = this.telegram.bot
        if (!bot) return
        bot.use(async (ctx) => {
            // Groups and channels are ignored: approvals only happen in private chats.
            if (ctx.chat?.type !== 'private') return
            const who = sender(ctx)
            if (!who) return
            if (!this.actionLimiter.hit(who.chatId)) {
                if (ctx.callbackQuery) {
                    await ctx.answerCallbackQuery({ text: 'Vas muy rápido 🐢 Espera un momento.' })
                }
                return
            }
            const found = await this.store.findByChatId(who.chatId)
            // A chat linked by a deactivated user is treated as unlinked (no order data, no
            // actions, not reactivated by writing) until an active admin links it again.
            const chat = found && !linkedByInactiveUser(found) ? found : null
            if (chat) await this.store.touch(chat, who)
            await this.route(ctx, who, chat)
        })
    }

    private async route(ctx: Context, who: TelegramSender, chat: TelegramChat | null) {
        const text = ctx.message?.text?.trim() ?? ''
        const command = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
        const name = command?.[1]?.toLowerCase()
        const args = command?.[2]?.trim() ?? ''

        if (name === 'start') return this.onStart(ctx, who, chat, args)
        if (!chat) return this.refuse(ctx)

        if (ctx.callbackQuery) {
            const action = parseCallback(ctx.callbackQuery.data)
            if (!action) {
                await ctx.answerCallbackQuery({ text: 'Este botón ya no es válido.' })
                return
            }
            return this.onCallback(ctx, chat, action)
        }
        if (!ctx.message) return
        if (name) this.pendingReasons.delete(chat.chatId)
        switch (name) {
            case 'ayuda':
            case 'help':
                await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' })
                return
            case 'pendientes':
                return this.onPending(ctx, chat)
            case 'pedido':
                return this.onOrder(ctx, chat, args)
            case 'micuenta':
                await ctx.reply(accountMessage(chat.linkedBy), { parse_mode: 'HTML' })
                return
            case 'salir':
                await ctx.reply(
                    '¿Seguro que quieres desvincular este chat? Dejarás de recibir los pagos y no podrás aprobarlos desde aquí.',
                    {
                        reply_markup: new InlineKeyboard()
                            .text(
                                'Sí, desvincular',
                                encodeCallback({ type: 'unlink', confirm: true }),
                            )
                            .text('Cancelar', encodeCallback({ type: 'unlink', confirm: false })),
                    },
                )
                return
            case undefined:
                if (text) return this.onText(ctx, chat, text)
                await ctx.reply('Por aquí solo entiendo texto y botones 🙂\n\n' + HELP_TEXT, {
                    parse_mode: 'HTML',
                })
                return
            default:
                await ctx.reply(`No conozco ese comando 🤔\n\n${HELP_TEXT}`, { parse_mode: 'HTML' })
        }
    }

    private async refuse(ctx: Context): Promise<void> {
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({
                text: '🔒 Este bot es privado del equipo de KaiZen.',
                show_alert: true,
            })
            return
        }
        await ctx.reply(PRIVATE_BOT_MESSAGE)
    }

    // Linking

    private async onStart(
        ctx: Context,
        who: TelegramSender,
        chat: TelegramChat | null,
        code: string,
    ): Promise<void> {
        if (/^\d{6}$/.test(code)) {
            if (!this.linkLimiter.hit(who.chatId) || !this.wrongCodeLimiter.hit('any')) {
                await ctx.reply(
                    'Hiciste muchos intentos seguidos ⏳ Espera unos minutos y vuelve a intentarlo con un código nuevo.',
                )
                return
            }
            const linked = await this.store.consumeLinkCode(code, who)
            if (linked) {
                this.logger.log(
                    `Chat ${who.chatId} linked (by user ${linked.linkedByUserId ?? '-'})`,
                )
                await ctx.reply(WELCOME_MESSAGE, { parse_mode: 'HTML' })
                return
            }
            if (!chat) {
                await ctx.reply(
                    `Ese código no es válido o ya venció 😕 Genera uno nuevo en el panel (sección Telegram) y envíalo así: /start 123456`,
                )
                return
            }
        }
        if (chat) {
            await ctx.reply(`Este chat ya está vinculado ✨\n\n${HELP_TEXT}`, {
                parse_mode: 'HTML',
            })
            return
        }
        await ctx.reply(PRIVATE_BOT_MESSAGE)
    }

    // Commands

    private async onPending(ctx: Context, chat: TelegramChat): Promise<void> {
        const orders = await this.dataSource.getRepository(Order).find({
            where: { status: 'PENDIENTE_VERIFICACION' },
            order: { updatedAt: 'ASC' },
        })
        if (!orders.length) {
            await ctx.reply('🎉 No hay pagos por verificar. ¡Todo al día!')
            return
        }
        const shown = orders.slice(0, PENDING_LIST_LIMIT)
        await ctx.reply(
            orders.length > shown.length
                ? `🧾 Hay ${orders.length} pagos por verificar. Te muestro los ${shown.length} más antiguos:`
                : `🧾 ${orders.length === 1 ? 'Hay 1 pago' : `Hay ${orders.length} pagos`} por verificar:`,
        )
        for (const order of shown) {
            const payment = await this.dataSource
                .getRepository(OrderPayment)
                .findOne({ where: { orderId: order.id, status: 'PENDIENTE' } })
            const context = payment ? await this.payments.loadPayment(payment.id) : null
            if (context)
                await this.payments.sendPayment(context, [chat.chatId], { withProof: false })
        }
    }

    private async onOrder(ctx: Context, chat: TelegramChat, args: string): Promise<void> {
        const code = normalizeOrderCode(args)
        if (!code) {
            await ctx.reply('Escríbeme el código del pedido, por ejemplo: /pedido KZ-000012')
            return
        }
        const order = await this.dataSource
            .getRepository(Order)
            .findOne({ where: { code }, relations: { items: true, payments: true } })
        if (!order) {
            await ctx.reply(`No encontré el pedido ${code} 🤔`)
            return
        }
        const pending = (order.payments ?? []).find((payment) => payment.status === 'PENDIENTE')
        if (order.status === 'PENDIENTE_VERIFICACION' && pending) {
            const context = await this.payments.loadPayment(pending.id)
            if (context) {
                await this.payments.sendPayment(context, [chat.chatId], { withProof: false })
                return
            }
        }
        const label = await this.catalog.labeler()
        const latest = [...(order.payments ?? [])].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        )[0]
        const paymentLabels = {
            PENDIENTE: 'por verificar',
            VERIFICADO: 'verificado',
            RECHAZADO: 'rechazado',
        }
        let text = orderSummaryMessage({
            code: order.code,
            statusLabel: label(order.status),
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            items: [...(order.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
            totalUsd: order.totalUsd,
            totalBs: order.totalBs,
            createdAt: order.createdAt,
            deliveryMethod: order.deliveryMethod,
            latestPayment: latest
                ? {
                      reference: latest.reference,
                      amountBs: latest.amountBs,
                      statusLabel: paymentLabels[latest.status],
                  }
                : null,
        })
        const url = this.payments.adminUrl(order.code)
        if (!isButtonUrl(url)) text += `\n🔗 Panel: ${escapeHtml(url)}`
        await ctx.reply(text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: isButtonUrl(url)
                ? new InlineKeyboard().url('🔗 Ver en el panel', url)
                : undefined,
        })
    }

    // Buttons

    private async onCallback(ctx: Context, chat: TelegramChat, action: CallbackAction) {
        switch (action.type) {
            case 'unlink':
                return this.onUnlink(ctx, chat, action.confirm)
            case 'verify':
            case 'verifyAck':
                return this.verify(ctx, chat, action.paymentId, action.type === 'verifyAck')
            case 'reject':
                return this.askRejectReason(ctx, chat, action.paymentId)
            case 'rejectReason':
                return this.reject(
                    ctx,
                    chat,
                    action.paymentId,
                    REJECT_REASONS[action.reason] as string,
                )
            case 'rejectOther':
                return this.askTypedReason(ctx, chat, action.paymentId)
            case 'cancel':
                if (this.pendingReasons.get(chat.chatId)?.paymentId === action.paymentId) {
                    this.pendingReasons.delete(chat.chatId)
                }
                await this.payments.deletePrompts(action.paymentId, chat.chatId)
                await ctx.answerCallbackQuery({ text: 'Listo, no hice nada 👍' })
        }
    }

    private async onUnlink(ctx: Context, chat: TelegramChat, confirm: boolean): Promise<void> {
        await ctx.answerCallbackQuery()
        if (!confirm) {
            await ctx
                .editMessageText('👌 Perfecto, este chat sigue vinculado.')
                .catch(() => undefined)
            return
        }
        this.pendingReasons.delete(chat.chatId)
        await this.store.unlink(chat.chatId)
        this.logger.log(`Chat ${chat.chatId} unlinked itself`)
        await ctx
            .editMessageText('👋 Listo, este chat quedó desvinculado. ¡Gracias por todo!')
            .catch(() => undefined)
    }

    /** Loads the payment behind a button; answers and returns null when it cannot be acted on. */
    private async pendingPayment(
        ctx: Context,
        chat: TelegramChat,
        paymentId: string,
    ): Promise<PaymentContext | null> {
        const context = await this.payments.loadPayment(paymentId)
        if (!context) {
            await this.notify(ctx, 'No encontré ese pago. Puede que el pedido ya no exista.')
            return null
        }
        if (!context.pending) {
            await this.alreadyHandled(ctx, chat, context)
            return null
        }
        return context
    }

    private async alreadyHandled(ctx: Context, chat: TelegramChat, context: PaymentContext) {
        const label = (await this.catalog.labeler())(context.order.status)
        await this.notify(ctx, `Este pago ya fue procesado: ${label}`)
        await this.payments.refreshPayment(context.payment.id, { chatId: chat.chatId })
        await this.payments.deletePrompts(context.payment.id, chat.chatId)
    }

    /** A toast for a button tap, or a plain reply for a typed message. */
    private async notify(ctx: Context, text: string): Promise<void> {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text })
        else await ctx.reply(text)
    }

    /** Runs `work` unless the same payment is already being handled (double taps). */
    private async exclusive(ctx: Context, paymentId: string, work: () => Promise<void>) {
        if (this.inFlight.has(paymentId)) {
            await this.notify(ctx, 'Un momento, ya lo estoy procesando ⏳')
            return
        }
        this.inFlight.add(paymentId)
        try {
            await work()
        } finally {
            this.inFlight.delete(paymentId)
        }
    }

    private actor(chat: TelegramChat): OrderActor {
        return { kind: 'telegram', userId: chat.linkedByUserId }
    }

    private async verify(
        ctx: Context,
        chat: TelegramChat,
        paymentId: string,
        acknowledged: boolean,
    ): Promise<void> {
        await this.exclusive(ctx, paymentId, async () => {
            const context = await this.pendingPayment(ctx, chat, paymentId)
            if (!context) return
            // No check of the stored stock conflict here: it is a snapshot. The transition
            // decides with the stock there is now and, when it is still short, refuses with the
            // current numbers, which `onTransitionError` turns into the confirmation question.
            const name = chatDisplayName(chat)
            try {
                await this.statuses.transition(
                    context.order.code,
                    'PAGO_VERIFICADO',
                    this.actor(chat),
                    {
                        note: `Confirmado desde Telegram por ${name}.`,
                        acknowledgeStockConflict: acknowledged || undefined,
                    },
                )
            } catch (error) {
                return this.onTransitionError(ctx, chat, context, error)
            }
            this.logger.log(`${context.order.code}: payment confirmed from chat ${chat.chatId}`)
            await this.payments.resolvePayment(
                paymentId,
                `✅ <b>Pago confirmado</b> por ${escapeHtml(name)} · ${formatCaracasTime(new Date())}`,
            )
            await this.notify(ctx, `✅ Pago confirmado. ${context.order.code} ya está verificado.`)
        })
    }

    private async askStockConfirmation(
        ctx: Context,
        chat: TelegramChat,
        context: PaymentContext,
        conflict: string,
    ): Promise<void> {
        const paymentId = context.payment.id
        await this.prompt(
            chat,
            context,
            `📦 <b>Falta stock para ${escapeHtml(context.order.code)}</b>\n${conflict}.\n\n¿Confirmas el pago igual? Se toma lo que haya y lo que falte queda anotado en el historial.`,
            new InlineKeyboard()
                .text(
                    '✅ Confirmar igual (falta stock)',
                    encodeCallback({ type: 'verifyAck', paymentId }),
                )
                .row()
                .text('Cancelar', encodeCallback({ type: 'cancel', paymentId })),
            ctx.callbackQuery?.message,
        )
        await this.notify(ctx, '📦 Falta stock: confirma de nuevo si quieres seguir.')
    }

    private async askRejectReason(ctx: Context, chat: TelegramChat, paymentId: string) {
        const context = await this.pendingPayment(ctx, chat, paymentId)
        if (!context) return
        const keyboard = new InlineKeyboard()
        REJECT_REASONS.forEach((reason, index) => {
            keyboard
                .text(reason, encodeCallback({ type: 'rejectReason', paymentId, reason: index }))
                .row()
        })
        keyboard
            .text('✍️ Otro motivo…', encodeCallback({ type: 'rejectOther', paymentId }))
            .row()
            .text('Cancelar', encodeCallback({ type: 'cancel', paymentId }))
        await this.prompt(
            chat,
            context,
            `❌ <b>¿Por qué rechazas el pago de ${escapeHtml(context.order.code)}?</b>\nEl cliente verá el motivo en la página de su pedido.`,
            keyboard,
            ctx.callbackQuery?.message,
        )
        await ctx.answerCallbackQuery()
    }

    private async askTypedReason(ctx: Context, chat: TelegramChat, paymentId: string) {
        const context = await this.pendingPayment(ctx, chat, paymentId)
        if (!context) return
        const sent = await this.prompt(
            chat,
            context,
            `✍️ Escribe el motivo del rechazo de <b>${escapeHtml(context.order.code)}</b> (máx. ${ORDER_LIMITS.reason} caracteres).`,
            { force_reply: true, input_field_placeholder: 'Motivo del rechazo' },
            undefined,
            { keepPrevious: true },
        )
        if (sent) {
            this.pendingReasons.set(chat.chatId, {
                paymentId,
                promptMessageId: sent.message_id,
                expiresAt: Date.now() + REASON_TTL_MS,
            })
        }
        await ctx.answerCallbackQuery()
    }

    /** A plain text: the typed rejection reason when one is expected. */
    private async onText(ctx: Context, chat: TelegramChat, text: string): Promise<void> {
        const pending = this.pendingReasons.get(chat.chatId)
        const replyTo = ctx.message?.reply_to_message?.message_id
        if (!pending || (replyTo !== undefined && replyTo !== pending.promptMessageId)) {
            await ctx.reply(`No entendí 🤔\n\n${HELP_TEXT}`, { parse_mode: 'HTML' })
            return
        }
        if (pending.expiresAt < Date.now()) {
            this.pendingReasons.delete(chat.chatId)
            await ctx.reply(
                'Se venció el tiempo para escribir el motivo ⏳ Toca ❌ Rechazar de nuevo.',
            )
            return
        }
        if ([...text].length > ORDER_LIMITS.reason) {
            await ctx.reply(
                `El motivo es muy largo (máx. ${ORDER_LIMITS.reason} caracteres). Escríbelo de nuevo, un poco más corto.`,
            )
            return
        }
        this.pendingReasons.delete(chat.chatId)
        await this.reject(ctx, chat, pending.paymentId, text)
    }

    private async reject(ctx: Context, chat: TelegramChat, paymentId: string, reason: string) {
        await this.exclusive(ctx, paymentId, async () => {
            const context = await this.pendingPayment(ctx, chat, paymentId)
            if (!context) return
            const name = chatDisplayName(chat)
            try {
                await this.statuses.transition(
                    context.order.code,
                    'PAGO_RECHAZADO',
                    this.actor(chat),
                    { note: reason },
                )
            } catch (error) {
                return this.onTransitionError(ctx, chat, context, error)
            }
            this.logger.log(`${context.order.code}: payment rejected from chat ${chat.chatId}`)
            await this.payments.resolvePayment(
                paymentId,
                `❌ <b>Pago rechazado</b> por ${escapeHtml(name)} · ${formatCaracasTime(new Date())}\nMotivo: ${escapeHtml(truncate(reason, 300))}`,
                { whatsapp: { issuedById: chat.linkedByUserId } },
            )
            await this.notify(ctx, `❌ Pago rechazado. El cliente verá el motivo en su pedido.`)
        })
    }

    private async onTransitionError(
        ctx: Context,
        chat: TelegramChat,
        context: PaymentContext,
        error: unknown,
    ): Promise<void> {
        const response = error instanceof BadRequestException ? error.getResponse() : null
        if (
            response &&
            typeof response === 'object' &&
            (response as { code?: string }).code === STOCK_CONFLICT_UNACKNOWLEDGED
        ) {
            // Still short with the current stock: ask with those numbers.
            const lines = (response as { lines?: unknown }).lines
            const short = Array.isArray(lines) ? (lines as StockConflictLine[]) : []
            if (short.length) {
                return this.askStockConfirmation(ctx, chat, context, stockLinesText(short))
            }
        }
        if (error instanceof ConflictException || error instanceof NotFoundException) {
            // Handled elsewhere in the meantime (the web, another chat).
            const fresh = await this.payments.loadPayment(context.payment.id)
            if (fresh) return this.alreadyHandled(ctx, chat, fresh)
        }
        this.logger.error(
            `${context.order.code}: Telegram action failed: ${(error as Error).message ?? String(error)}`,
        )
        await this.notify(ctx, 'No pude completar la acción 😕 Intenta de nuevo o usa el panel.')
    }

    /**
     * Sends a follow-up question about a payment (as a reply to the tapped message when there
     * is one) and tracks it, so it is deleted once the payment is handled.
     */
    private async prompt(
        chat: TelegramChat,
        context: PaymentContext,
        text: string,
        markup: InlineKeyboard | { force_reply: true; input_field_placeholder: string },
        replyTo?: Message | { message_id: number },
        options: { keepPrevious?: boolean } = {},
    ): Promise<Message | null> {
        const api = this.telegram.api
        if (!api) return null
        // One open question per payment and chat (the typed reason keeps the reasons' Cancelar).
        if (!options.keepPrevious)
            await this.payments.deletePrompts(context.payment.id, chat.chatId)
        const sent = await this.payments.deliver(chat.chatId, 'sendMessage', () =>
            api.sendMessage(chat.chatId, text, {
                parse_mode: 'HTML',
                reply_markup: markup,
                ...(replyTo
                    ? {
                          reply_parameters: {
                              message_id: replyTo.message_id,
                              allow_sending_without_reply: true,
                          },
                      }
                    : {}),
            }),
        )
        if (sent) {
            await this.store.recordMessages([
                {
                    chatId: chat.chatId,
                    messageId: sent.message_id,
                    orderId: context.order.id,
                    paymentId: context.payment.id,
                    kind: 'prompt',
                },
            ])
        }
        return sent
    }
}
