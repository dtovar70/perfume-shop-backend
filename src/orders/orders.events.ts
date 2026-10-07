import type { PaymentSource } from './entities/order-payment.entity.js'
import type { ActorKind, OrderStatus, RefundStatus } from './order-status.js'

/**
 * Domain events of an order change. Notifications (customer emails, the Telegram bot) are
 * OutboxHandlers of these events: their rows are written in the change's transaction and
 * delivered with retries. The events are also emitted after commit for in-process reactions
 * (`@OnEvent`: cache invalidation, waking the outbox worker). Neither side touches the order
 * logic; to act on an order they call `OrderStatusService.transition()` like the admin API does.
 */
export const ORDER_EVENTS = {
    created: 'order.created',
    paymentSubmitted: 'order.payment_submitted',
    statusChanged: 'order.status_changed',
    refundUpdated: 'order.refund_updated',
} as const

export interface OrderCreatedEvent {
    orderId: string
    code: string
    customerName: string
    customerPhone: string
    totalUsd: number
    totalBs: number
    exchangeRate: number
    itemCount: number
    paymentDueAt: string
    createdAt: string
}

export interface OrderPaymentSubmittedEvent {
    orderId: string
    code: string
    paymentId: string
    reference: string
    payerBankCode: string
    payerBankName: string
    amountBs: number
    expectedBs: number
    /** Paid minus expected (0 when exact). */
    amountDifferenceBs: number
    duplicateReference: boolean
    hasProof: boolean
    /** Sent after the payment deadline or while the order was expired. */
    late: boolean
    /** `admin` when an admin recorded a proof the customer sent by WhatsApp. */
    source: PaymentSource
    /** The order could not take all its stock back (see `Order.stockConflict`). */
    stockConflict: boolean
    submittedAt: string
}

export interface OrderStatusChangedEvent {
    orderId: string
    code: string
    from: OrderStatus
    to: OrderStatus
    actor: ActorKind
    /** Admin user id when the actor is an admin (or a linked Telegram user). */
    actorUserId: string | null
    note: string | null
    changedAt: string
}

/** A cancellation recorded whether money must be given back, or the refund was marked done. */
export interface OrderRefundUpdatedEvent {
    orderId: string
    code: string
    refundStatus: RefundStatus
    reference: string | null
    actorUserId: string | null
    updatedAt: string
}
