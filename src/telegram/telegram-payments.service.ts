import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectDataSource } from '@nestjs/typeorm'
import { GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { Message } from 'grammy/types'
import type { Readable } from 'node:stream'
import { DataSource, In } from 'typeorm'
import { User } from '../auth/entities/user.entity.js'
import { OrderStatusCatalogService } from '../catalogs/order-status-catalog.service.js'
import type { Env } from '../config/env.schema.js'
import { AdminOrdersService } from '../orders/admin-orders.service.js'
import { OrderPayment } from '../orders/entities/order-payment.entity.js'
import { Order } from '../orders/entities/order.entity.js'
import { OrderWhatsAppService } from '../orders/whatsapp/order-whatsapp.service.js'
import type { TelegramChat } from './entities/telegram-chat.entity.js'
import type { TelegramMessage } from './entities/telegram-message.entity.js'
import { encodeCallback } from './telegram-callbacks.js'
import { TelegramBotService } from './telegram-bot.service.js'
import {
    escapeHtml,
    formatCaracasTime,
    newOrderMessage,
    paymentMessage,
    TELEGRAM_CAPTION_LIMIT,
    TELEGRAM_TEXT_LIMIT,
    truncate,
    visibleLength,
    type PaymentMessageData,
} from './telegram-format.js'
import { TelegramStoreService, type NewTelegramMessage } from './telegram-store.service.js'

/** Largest proof the bot downloads to forward (Telegram accepts photos up to 10 MB). */
const MAX_PROOF_BYTES = 10 * 1024 * 1024
const PROOF_FETCH_TIMEOUT_MS = 15_000

/** A payment with its order, ready to render. */
export interface PaymentContext {
    order: Order
    payment: OrderPayment
    data: PaymentMessageData
    /** The order can still be confirmed or rejected with this payment. */
    pending: boolean
}

export interface ProofImage {
    buffer: Buffer
    filename: string
}

/**
 * Telegram refuses URL buttons pointing to localhost or bare hosts ("http://localhost:5173"), and
 * a refused button fails the whole message. Such links go in the text instead.
 */
export function isButtonUrl(url: string): boolean {
    try {
        const { protocol, hostname } = new URL(url)
        if (protocol !== 'https:' && protocol !== 'http:') return false
        if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false
        if (/^(127\.|10\.|192\.168\.|0\.)/.test(hostname) || hostname.startsWith('[')) return false
        return hostname.includes('.')
    } catch {
        return false
    }
}

function extensionFor(contentType: string): string {
    if (contentType.includes('png')) return 'png'
    if (contentType.includes('webp')) return 'webp'
    return 'jpg'
}

async function readStream(stream: Readable, limit: number): Promise<Buffer | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        size += buffer.length
        if (size > limit) {
            stream.destroy()
            return null
        }
        chunks.push(buffer)
    }
    return Buffer.concat(chunks)
}

/** Telegram's "nothing changed" answer to an edit: harmless. */
function isNotModified(error: unknown): boolean {
    return error instanceof GrammyError && /message is not modified/i.test(error.description)
}

function isGone(error: unknown): boolean {
    return (
        error instanceof GrammyError &&
        /message to edit not found|message to delete not found|message can't be (edited|deleted)/i.test(
            error.description,
        )
    )
}

/** 403 (blocked, kicked) or "chat not found": the chat cannot receive messages any more. */
function isChatUnreachable(error: unknown): boolean {
    return (
        error instanceof GrammyError &&
        (error.error_code === 403 || /chat not found/i.test(error.description))
    )
}

/**
 * Payment notifications and their follow-up edits: renders a payment from the database, sends
 * it (with the private proof photo) to every linked chat, and re-renders every copy when the
 * payment is handled from any side, so nobody acts on stale buttons.
 */
@Injectable()
export class TelegramPaymentsService {
    private readonly logger = new Logger('TelegramPayments')
    private readonly siteUrl: string

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly telegram: TelegramBotService,
        private readonly store: TelegramStoreService,
        private readonly catalog: OrderStatusCatalogService,
        private readonly adminOrders: AdminOrdersService,
        private readonly whatsapp: OrderWhatsAppService,
        config: ConfigService<Env, true>,
    ) {
        this.siteUrl = config.get('PUBLIC_SITE_URL', { infer: true })
    }

    adminUrl(code: string): string {
        return `${this.siteUrl}/admin/pedidos/${encodeURIComponent(code)}`
    }

    // Loading and rendering

    async userName(id: string | null): Promise<string | null> {
        if (!id) return null
        const user = await this.dataSource.getRepository(User).findOneBy({ id })
        return user?.name ?? null
    }

    async loadPayment(paymentId: string): Promise<PaymentContext | null> {
        const [context] = await this.loadPayments([paymentId])
        return context ?? null
    }

    /**
     * Several payments with their orders (and items) in a fixed number of queries, whatever
     * their count; returned in the order of `paymentIds`, skipping the ones not found.
     */
    async loadPayments(paymentIds: readonly string[]): Promise<PaymentContext[]> {
        if (!paymentIds.length) return []
        const payments = await this.dataSource
            .getRepository(OrderPayment)
            .find({ where: { id: In([...paymentIds]) } })
        const orders = payments.length
            ? await this.dataSource.getRepository(Order).find({
                  where: { id: In(payments.map((payment) => payment.orderId)) },
                  relations: { items: true },
              })
            : []
        const recorderIds = payments.flatMap((payment) =>
            payment.source === 'admin' && payment.recordedById ? [payment.recordedById] : [],
        )
        const recorders = recorderIds.length
            ? await this.dataSource
                  .getRepository(User)
                  .find({ where: { id: In(recorderIds) }, select: { id: true, name: true } })
            : []

        const paymentById = new Map(payments.map((payment) => [payment.id, payment]))
        const orderById = new Map(orders.map((order) => [order.id, order]))
        const nameById = new Map(recorders.map((user) => [user.id, user.name]))
        return paymentIds.flatMap((id) => {
            const payment = paymentById.get(id)
            const order = payment && orderById.get(payment.orderId)
            if (!payment || !order) return []
            const recordedByName = payment.recordedById
                ? (nameById.get(payment.recordedById) ?? null)
                : null
            return [this.toContext(order, payment, recordedByName)]
        })
    }

    private toContext(
        order: Order,
        payment: OrderPayment,
        recordedByName: string | null,
    ): PaymentContext {
        const items = [...(order.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
        return {
            order,
            payment,
            pending: payment.status === 'PENDIENTE' && order.status === 'PENDIENTE_VERIFICACION',
            data: {
                code: order.code,
                customerName: order.customerName,
                customerPhone: order.customerPhone,
                items,
                totalUsd: order.totalUsd,
                totalBs: order.totalBs,
                exchangeRate: order.exchangeRate,
                stockConflict: order.stockConflict,
                payment: {
                    reference: payment.reference,
                    payerBankCode: payment.payerBankCode,
                    payerBankName: payment.payerBankName,
                    payerPhone: payment.payerPhone,
                    payerIdNumber: payment.payerIdNumber,
                    paidOn: payment.paidOn,
                    amountBs: payment.amountBs,
                    expectedBs: payment.expectedBs,
                    duplicateReference: payment.duplicateReference,
                    late: payment.late,
                    source: payment.source,
                    recordedByName: payment.source === 'admin' ? recordedByName : null,
                    hasProof: payment.hasProof,
                },
                adminUrl: this.adminUrl(order.code),
            },
        }
    }

    /** The details text, fitted to Telegram's limit (caption or message). */
    render(context: PaymentContext, resolution: string | null, limit = TELEGRAM_TEXT_LIMIT) {
        const title = context.pending
            ? '🧾 <b>Nuevo pago por verificar</b>'
            : resolution
              ? '🧾 <b>Pago</b>'
              : '🧾 <b>Pago por verificar</b>'
        const panelLine = isButtonUrl(context.data.adminUrl)
            ? null
            : `🔗 Panel: ${escapeHtml(context.data.adminUrl)}`
        // The panel link (when it cannot be a button) goes before the outcome, which stays last.
        const build = (data: PaymentMessageData) =>
            [paymentMessage(data, { title }) + (panelLine ? `\n${panelLine}` : ''), resolution]
                .filter(Boolean)
                .join('\n\n')
        const full = build(context.data)
        if (visibleLength(full) <= limit) return full
        // Too long (a caption): without the item list. Null when even that does not fit.
        const compact = build({ ...context.data, items: [] })
        return visibleLength(compact) <= limit ? compact : null
    }

    pendingKeyboard(context: PaymentContext): InlineKeyboard {
        const paymentId = context.payment.id
        const keyboard = new InlineKeyboard()
            .text('✅ Pago recibido', encodeCallback({ type: 'verify', paymentId }))
            .text('❌ Rechazar', encodeCallback({ type: 'reject', paymentId }))
        if (isButtonUrl(context.data.adminUrl)) {
            keyboard.row().url('🔗 Ver en el panel', context.data.adminUrl)
        }
        return keyboard
    }

    resolvedKeyboard(context: PaymentContext, whatsappUrl: string | null): InlineKeyboard {
        const keyboard = new InlineKeyboard()
        if (whatsappUrl) keyboard.url('💬 Avisar al cliente por WhatsApp', whatsappUrl).row()
        if (isButtonUrl(context.data.adminUrl)) {
            keyboard.url('🔗 Ver en el panel', context.data.adminUrl)
        }
        return keyboard
    }

    /** The line shown when no stored resolution exists (e.g. a refresh of a stale message). */
    async fallbackResolution(context: PaymentContext): Promise<string | null> {
        if (context.pending) return null
        const { payment, order } = context
        const reviewer = await this.userName(payment.reviewedById)
        const by = reviewer ? ` por ${escapeHtml(reviewer)}` : ''
        const at = payment.reviewedAt ? ` · ${formatCaracasTime(payment.reviewedAt)}` : ''
        if (payment.status === 'VERIFICADO') return `✅ <b>Pago confirmado</b>${by}${at}`
        if (payment.status === 'RECHAZADO') {
            const reason = payment.rejectionReason
                ? `\nMotivo: ${escapeHtml(truncate(payment.rejectionReason, 300))}`
                : ''
            return `❌ <b>Pago rechazado</b>${by}${at}${reason}`
        }
        const label = (await this.catalog.labeler())(order.status)
        return `ℹ️ El pedido ahora está en <b>${escapeHtml(label)}</b>`
    }

    // Sending

    /**
     * Runs one Bot API call for a chat. A chat that blocked the bot is deactivated; every other
     * failure is logged (never thrown), so one chat can never break the others.
     */
    async deliver<T>(chatId: string, what: string, call: () => Promise<T>): Promise<T | null> {
        try {
            return await call()
        } catch (error) {
            if (isChatUnreachable(error)) {
                this.logger.warn(`Chat ${chatId} is unreachable (${what}); marking it inactive`)
                await this.store.deactivate(chatId).catch(() => undefined)
            } else {
                this.logger.error(
                    `Telegram ${what} to chat ${chatId} failed: ${this.telegram.describe(error)}`,
                )
            }
            return null
        }
    }

    /** The private proof screenshot, read through the storage service (never a public URL). */
    async readProof(context: PaymentContext): Promise<ProofImage | null> {
        if (!context.payment.hasProof) return null
        try {
            const access = await this.adminOrders.paymentProof(
                context.order.code,
                context.payment.id,
            )
            if (access.kind === 'stream') {
                const buffer = await readStream(access.stream, MAX_PROOF_BYTES)
                return buffer
                    ? { buffer, filename: `comprobante.${extensionFor(access.contentType)}` }
                    : null
            }
            const response = await fetch(access.url, {
                signal: AbortSignal.timeout(PROOF_FETCH_TIMEOUT_MS),
            })
            const contentType = response.headers.get('content-type') ?? ''
            const length = Number(response.headers.get('content-length') ?? 0)
            if (!response.ok || !contentType.startsWith('image/') || length > MAX_PROOF_BYTES) {
                this.logger.warn(
                    `Could not download the proof of ${context.order.code} (HTTP ${response.status})`,
                )
                return null
            }
            const buffer = Buffer.from(await response.arrayBuffer())
            return buffer.length <= MAX_PROOF_BYTES
                ? { buffer, filename: `comprobante.${extensionFor(contentType)}` }
                : null
        } catch (error) {
            this.logger.warn(
                `Could not read the proof of ${context.order.code}: ${(error as Error).message}`,
            )
            return null
        }
    }

    /**
     * Sends a payment to the given chats: the proof photo (details as its caption when they fit,
     * otherwise the photo and then the details), with the action buttons while it is pending.
     * The photo is uploaded once; the other chats reuse Telegram's file id.
     */
    async sendPayment(
        context: PaymentContext,
        chatIds: readonly string[],
        options: { withProof: boolean },
    ): Promise<number> {
        const api = this.telegram.api
        if (!api || !chatIds.length) return 0
        const text = this.render(context, null)
        if (!text) return 0
        const caption = this.render(context, null, TELEGRAM_CAPTION_LIMIT)
        const keyboard = context.pending ? this.pendingKeyboard(context) : undefined
        const proof = options.withProof ? await this.readProof(context) : null
        let photo: string | InputFile | null = proof
            ? new InputFile(proof.buffer, proof.filename)
            : null
        const records: NewTelegramMessage[] = []
        const record = (chatId: string, message: Message, kind: NewTelegramMessage['kind']) =>
            records.push({
                chatId,
                messageId: message.message_id,
                orderId: context.order.id,
                paymentId: context.payment.id,
                kind,
            })

        let delivered = 0
        for (const chatId of chatIds) {
            if (photo) {
                const sent = await this.deliver(chatId, 'sendPhoto', () =>
                    api.sendPhoto(
                        chatId,
                        photo as string | InputFile,
                        caption
                            ? { caption, parse_mode: 'HTML', reply_markup: keyboard }
                            : {
                                  caption: `📎 Captura del pago · <b>${escapeHtml(context.order.code)}</b>`,
                                  parse_mode: 'HTML',
                              },
                    ),
                )
                if (sent) {
                    photo = sent.photo?.at(-1)?.file_id ?? photo
                    record(chatId, sent, caption ? 'payment_caption' : 'payment_photo')
                    if (caption) {
                        delivered++
                        continue
                    }
                }
            }
            const sent = await this.deliver(chatId, 'sendMessage', () =>
                api.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                    link_preview_options: { is_disabled: true },
                }),
            )
            if (sent) {
                record(chatId, sent, 'payment')
                delivered++
            }
        }
        await this.store.recordMessages(records)
        return delivered
    }

    /**
     * `order.payment_submitted`: every active linked chat gets the payment. Chats that already
     * hold a copy are skipped, so a repeated delivery (outbox retry) only completes the missing
     * ones. Resolves how many active chats still lack it (0 when done or nothing to send).
     */
    async notifyPaymentSubmitted(paymentId: string): Promise<number> {
        if (!this.telegram.enabled) return 0
        const missing = () => this.chatsWithout(this.store.paymentMessages(paymentId))
        const targets = await missing()
        if (!targets.length) return 0
        const context = await this.loadPayment(paymentId)
        // Already handled in the meantime (or gone): nothing to ask.
        if (!context?.pending) return 0
        await this.sendPayment(
            context,
            targets.map((chat) => chat.chatId),
            { withProof: true },
        )
        return (await missing()).length
    }

    /**
     * `order.created`: a short notice to the chats that asked for new orders, skipping those
     * that already got it. Resolves how many of them still lack it.
     */
    async notifyOrderCreated(orderId: string): Promise<number> {
        const api = this.telegram.api
        if (!api) return 0
        const missing = () =>
            this.chatsWithout(this.store.newOrderMessages(orderId), { newOrders: true })
        const chats = await missing()
        if (!chats.length) return 0
        const order = await this.dataSource
            .getRepository(Order)
            .findOne({ where: { id: orderId }, relations: { items: true } })
        if (!order) return 0
        const items = [...(order.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
        const url = this.adminUrl(order.code)
        let text = newOrderMessage({
            code: order.code,
            customerName: order.customerName,
            totalUsd: order.totalUsd,
            totalBs: order.totalBs,
            itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
            items,
            paymentDueAt: order.paymentDueAt,
        })
        if (!isButtonUrl(url)) text += `\n🔗 Panel: ${escapeHtml(url)}`
        const keyboard = isButtonUrl(url)
            ? new InlineKeyboard().url('🔗 Ver en el panel', url)
            : undefined
        const records: NewTelegramMessage[] = []
        for (const chat of chats) {
            const sent = await this.deliver(chat.chatId, 'sendMessage', () =>
                api.sendMessage(chat.chatId, text, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                    link_preview_options: { is_disabled: true },
                }),
            )
            if (sent) {
                records.push({
                    chatId: chat.chatId,
                    messageId: sent.message_id,
                    orderId: order.id,
                    paymentId: null,
                    kind: 'new_order',
                })
            }
        }
        await this.store.recordMessages(records)
        return (await missing()).length
    }

    /**
     * Active chats with no message among `copies`. Chats found unreachable while sending were
     * deactivated, so they no longer count as missing.
     */
    private async chatsWithout(
        copies: Promise<TelegramMessage[]>,
        filter: { newOrders?: boolean } = {},
    ): Promise<TelegramChat[]> {
        const [chats, sent] = await Promise.all([this.store.activeChats(filter), copies])
        const reached = new Set(sent.map((message) => String(message.chatId)))
        return chats.filter((chat) => !reached.has(String(chat.chatId)))
    }

    /**
     * A plain notice (HTML) to every active linked chat, with a "Ver en el panel" button for the
     * given admin path (in the text when the site URL cannot be a button). Nothing is tracked.
     */
    async broadcast(text: string, panelPath: string): Promise<number> {
        const api = this.telegram.api
        if (!api) return 0
        const chats = await this.store.activeChats()
        if (!chats.length) return 0
        const url = `${this.siteUrl}${panelPath}`
        const body = isButtonUrl(url) ? text : `${text}\n🔗 Panel: ${escapeHtml(url)}`
        const keyboard = isButtonUrl(url)
            ? new InlineKeyboard().url('🔗 Ver en el panel', url)
            : undefined
        let delivered = 0
        for (const chat of chats) {
            const sent = await this.deliver(chat.chatId, 'sendMessage', () =>
                api.sendMessage(chat.chatId, body, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                    link_preview_options: { is_disabled: true },
                }),
            )
            if (sent) delivered++
        }
        return delivered
    }

    // Follow-up edits

    /**
     * The payment was handled (confirmed, rejected, the order cancelled…): stores the line to
     * append, re-renders every copy of the payment in every chat without the action buttons and
     * deletes the pending questions about it. `whatsappIssuedBy` adds the "Avisar al cliente por
     * WhatsApp" button (a fresh customer link is issued on their behalf).
     */
    async resolvePayment(
        paymentId: string,
        resolution: string,
        options: { whatsapp?: { issuedById: string | null } } = {},
    ): Promise<void> {
        await this.store.setResolution(paymentId, resolution)
        let whatsappUrl: string | null = null
        if (options.whatsapp) {
            const context = await this.loadPayment(paymentId)
            if (context) {
                try {
                    const message = await this.whatsapp.prepare(
                        context.order.code,
                        options.whatsapp.issuedById,
                    )
                    whatsappUrl = message.url
                } catch (error) {
                    this.logger.warn(
                        `WhatsApp reminder for ${context.order.code} failed: ${(error as Error).message}`,
                    )
                }
            }
        }
        await this.refreshPayment(paymentId, { whatsappUrl })
        await this.deletePrompts(paymentId)
    }

    /** Re-renders every tracked copy of the payment from the database. */
    async refreshPayment(
        paymentId: string,
        options: { whatsappUrl?: string | null; chatId?: string } = {},
    ): Promise<void> {
        const api = this.telegram.api
        if (!api) return
        const context = await this.loadPayment(paymentId)
        if (!context) return
        const rows = (await this.store.paymentMessages(paymentId)).filter(
            (row) => !options.chatId || row.chatId === options.chatId,
        )
        if (!rows.length) return
        const fallback = await this.fallbackResolution(context)
        const gone: string[] = []
        for (const row of rows) {
            const resolution = context.pending ? null : (row.resolution ?? fallback)
            const keyboard = context.pending
                ? this.pendingKeyboard(context)
                : this.resolvedKeyboard(context, options.whatsappUrl ?? null)
            const ok = await this.editDetails(row, context, resolution, keyboard)
            if (ok === 'gone') gone.push(row.id)
        }
        await this.store.deleteMessages(gone)
    }

    private async editDetails(
        row: TelegramMessage,
        context: PaymentContext,
        resolution: string | null,
        keyboard: InlineKeyboard,
    ): Promise<'ok' | 'gone' | 'failed'> {
        const api = this.telegram.api
        if (!api) return 'failed'
        const caption = row.kind === 'payment_caption'
        const text = this.render(
            context,
            resolution,
            caption ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT,
        )
        try {
            if (caption) {
                await api.editMessageCaption(row.chatId, row.messageId, {
                    ...(text ? { caption: text, parse_mode: 'HTML' as const } : {}),
                    reply_markup: keyboard,
                })
            } else if (text) {
                await api.editMessageText(row.chatId, row.messageId, text, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                    link_preview_options: { is_disabled: true },
                })
            }
            return 'ok'
        } catch (error) {
            if (isNotModified(error)) return 'ok'
            if (isGone(error)) return 'gone'
            if (isChatUnreachable(error)) {
                await this.store.deactivate(row.chatId).catch(() => undefined)
                return 'failed'
            }
            this.logger.error(
                `Editing message ${row.messageId} in chat ${row.chatId} failed: ${this.telegram.describe(error)}`,
            )
            return 'failed'
        }
    }

    /** Deletes the follow-up questions about a payment (all chats, or one). */
    async deletePrompts(paymentId: string, chatId?: string): Promise<void> {
        const api = this.telegram.api
        const prompts = await this.store.promptMessages(paymentId, chatId)
        if (!api || !prompts.length) return
        for (const prompt of prompts) {
            try {
                await api.deleteMessage(prompt.chatId, prompt.messageId)
            } catch (error) {
                // Older than 48 h cannot be deleted: at least drop its buttons.
                if (!isGone(error)) {
                    await api
                        .editMessageReplyMarkup(prompt.chatId, prompt.messageId)
                        .catch(() => undefined)
                }
            }
        }
        await this.store.deleteMessages(prompts.map((prompt) => prompt.id))
    }

    /** The payments of an order that have copies in Telegram still waiting for an outcome. */
    async unresolvedPaymentIds(orderId: string): Promise<string[]> {
        const rows = await this.store.orderPaymentMessages(orderId)
        return [
            ...new Set(
                rows.filter((row) => !row.resolution && row.paymentId).map((row) => row.paymentId!),
            ),
        ]
    }
}
