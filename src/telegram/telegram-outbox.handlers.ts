import { Injectable, type OnModuleInit } from '@nestjs/common'
import {
    ORDER_EVENTS,
    type OrderCreatedEvent,
    type OrderPaymentSubmittedEvent,
    type OrderStatusChangedEvent,
} from '../orders/orders.events.js'
import { OutboxRegistry, type OutboxHandler } from '../outbox/outbox-handler.js'
import { TelegramBotService } from './telegram-bot.service.js'
import { escapeHtml, formatCaracasTime, truncate } from './telegram-format.js'
import { TelegramPaymentsService } from './telegram-payments.service.js'

/** Chats still missing a notification after an attempt: the outbox retries the rest later. */
function assertAllReached(missing: number, what: string): void {
    if (missing > 0) throw new Error(`${what}: ${missing} Telegram chat(s) not reached`)
}

/**
 * Order notifications to the linked chats, delivered through the outbox (retried on failure).
 * Each registers only while the bot is enabled, and skips the chats an earlier attempt already
 * reached, so a retry never sends the same message twice to a chat.
 */
// Decorated so its constructor parameters (inherited by the handlers) are injectable.
@Injectable()
abstract class TelegramOutboxHandler<P extends object> implements OutboxHandler<P>, OnModuleInit {
    abstract readonly type: string
    abstract readonly event: string

    constructor(
        protected readonly telegram: TelegramBotService,
        protected readonly payments: TelegramPaymentsService,
        private readonly registry: OutboxRegistry,
    ) {}

    onModuleInit(): void {
        this.registry.register(this)
    }

    wants(_payload: P): boolean {
        return this.telegram.enabled
    }

    abstract handle(payload: P): Promise<void>
}

/** `order.payment_submitted`: the payment (with the proof and the buttons) to every chat. */
@Injectable()
export class TelegramPaymentSubmittedHandler extends TelegramOutboxHandler<OrderPaymentSubmittedEvent> {
    readonly type = 'telegram.payment_submitted'
    readonly event = ORDER_EVENTS.paymentSubmitted

    async handle(event: OrderPaymentSubmittedEvent): Promise<void> {
        const missing = await this.payments.notifyPaymentSubmitted(event.paymentId)
        assertAllReached(missing, `Payment of ${event.code}`)
    }
}

/** `order.created`: the "Nuevo pedido" notice to the chats that asked for it. */
@Injectable()
export class TelegramOrderCreatedHandler extends TelegramOutboxHandler<OrderCreatedEvent> {
    readonly type = 'telegram.order_created'
    readonly event = ORDER_EVENTS.created

    async handle(event: OrderCreatedEvent): Promise<void> {
        const missing = await this.payments.notifyOrderCreated(event.orderId)
        assertAllReached(missing, `New order ${event.code}`)
    }
}

/**
 * A payment under verification was handled from the web (or the order was cancelled): the
 * Telegram copies lose their buttons and say who did it. Moves made from Telegram update the
 * messages themselves (they know the chat's name), so they record nothing here. Repeating it is
 * harmless: the first recorded outcome wins and the copies are re-rendered from the database.
 */
@Injectable()
export class TelegramPaymentResolvedHandler extends TelegramOutboxHandler<OrderStatusChangedEvent> {
    readonly type = 'telegram.payment_resolved'
    readonly event = ORDER_EVENTS.statusChanged

    override wants(event: OrderStatusChangedEvent): boolean {
        return (
            super.wants(event) &&
            event.from === 'PENDIENTE_VERIFICACION' &&
            event.actor !== 'telegram'
        )
    }

    async handle(event: OrderStatusChangedEvent): Promise<void> {
        const paymentIds = await this.payments.unresolvedPaymentIds(event.orderId)
        if (!paymentIds.length) return
        const name = await this.payments.userName(event.actorUserId)
        const resolution = webResolution(event, name)
        for (const paymentId of paymentIds) {
            await this.payments.resolvePayment(
                paymentId,
                resolution,
                event.to === 'PAGO_RECHAZADO'
                    ? { whatsapp: { issuedById: event.actorUserId } }
                    : {},
            )
        }
    }
}

/** The line appended to the Telegram copies when the web handled the payment. */
export function webResolution(event: OrderStatusChangedEvent, name: string | null): string {
    const by = name ? ` por ${escapeHtml(name)}` : ''
    const at = formatCaracasTime(new Date(event.changedAt))
    const note = event.note ? `\nMotivo: ${escapeHtml(truncate(event.note, 300))}` : ''
    switch (event.to) {
        case 'PAGO_VERIFICADO':
            return `✅ <b>Pago confirmado</b>${by} desde el panel · ${at}`
        case 'PAGO_RECHAZADO':
            return `❌ <b>Pago rechazado</b>${by} desde el panel · ${at}${note}`
        case 'CANCELADO':
            return `🚫 <b>Pedido cancelado</b>${by} desde el panel · ${at}${note}`
        default:
            return `ℹ️ Pedido actualizado${by} desde el panel · ${at}`
    }
}

export const TELEGRAM_OUTBOX_HANDLERS = [
    TelegramPaymentSubmittedHandler,
    TelegramOrderCreatedHandler,
    TelegramPaymentResolvedHandler,
]
