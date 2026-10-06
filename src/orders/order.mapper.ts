import { caracasDay } from '../common/utils/caracas-date.js'
import type { PaymentContent } from '../content/content.types.js'
import { RATE_SOURCE_LABELS, type RateSource } from '../exchange-rate/providers/rate-provider.js'
import type { OrderItem } from './entities/order-item.entity.js'
import type { OrderNote } from './entities/order-note.entity.js'
import type { OrderPayment, PaymentSource, PaymentStatus } from './entities/order-payment.entity.js'
import type { OrderStatusHistory } from './entities/order-status-history.entity.js'
import type { Order } from './entities/order.entity.js'
import { amountDifferenceBs, type DeliveryMethod } from './order-pricing.js'
import { hasReceipt } from './receipt/receipt-availability.js'
import type { LiveStockConflict } from './stock-conflict.js'
import type { StatusLabeler } from '../catalogs/order-status-catalog.service.js'
import {
    PAYABLE_STATUSES,
    REFUND_STATUS_LABELS,
    type ActorKind,
    type OrderStatus,
    type RefundStatus,
    type TransitionRule,
} from './order-status.js'

export interface OrderCustomerDto {
    fullName: string
    email: string
    phone: string
    city: string
    address: string
    deliveryMethod: DeliveryMethod
    notes: string
}

export interface OrderItemDto {
    productId: string | null
    productName: string
    productSlug: string
    variantId: string | null
    variantLabel: string | null
    imageUrl: string | null
    unitPriceUsd: number
    quantity: number
    lineTotalUsd: number
}

export interface AdminOrderItemDto extends OrderItemDto {
    id: string
}

export interface OrderTotalsDto {
    subtotalUsd: number
    shippingUsd: number
    totalUsd: number
    totalBs: number
    exchangeRate: number
    exchangeRateDate: string
    exchangeRateSource: RateSource
    exchangeRateSourceLabel: string
}

export interface PublicPaymentDto {
    id: string
    status: PaymentStatus
    reference: string
    payerBankCode: string
    payerBankName: string
    amountBs: number
    paidOn: string
    hasProof: boolean
    rejectionReason: string | null
    createdAt: string
}

export interface OrderHistoryEntryDto {
    status: OrderStatus
    label: string
    at: string
    /** Only for customer-facing notes: rejection/cancellation reasons and shipping details. */
    note: string | null
}

/** What the customer sees at `/pedido/:code?t=`. */
export interface PublicOrderDto {
    code: string
    status: OrderStatus
    statusLabel: string
    createdAt: string
    paymentDueAt: string
    /** The customer may send a payment proof now. */
    canSubmitPayment: boolean
    /** The purchase receipt PDF can be downloaded (verified payment, not cancelled). */
    receiptAvailable: boolean
    customer: OrderCustomerDto
    items: OrderItemDto[]
    totals: OrderTotalsDto
    /** Where to pay (current Pago Móvil details); null when they are not configured. */
    pagoMovil: PaymentContent | null
    payments: PublicPaymentDto[]
    history: OrderHistoryEntryDto[]
}

export interface PaymentFlagsDto {
    duplicateReference: boolean
    amountMismatch: boolean
    /** Paid minus expected (Bs); 0 when exact. */
    amountDifferenceBs: number
}

export interface AdminPaymentDto extends PublicPaymentDto, PaymentFlagsDto {
    /** Recorded after the deadline or while the order was expired. */
    late: boolean
    /** `admin`: recorded by an admin from a proof the customer sent by WhatsApp. */
    source: PaymentSource
    recordedBy: { id: string; name: string } | null
    payerPhone: string
    payerIdNumber: string | null
    expectedBs: number
    /** API path of the screenshot (authenticated); null when none was sent. */
    proofPath: string | null
    reviewedAt: string | null
    reviewedBy: { id: string; name: string } | null
}

export interface AdminHistoryEntryDto {
    from: OrderStatus | null
    to: OrderStatus
    label: string
    actor: ActorKind
    actorName: string
    note: string | null
    at: string
}

export interface AdminNoteDto {
    id: string
    body: string
    author: { id: string; name: string } | null
    createdAt: string
}

export interface AllowedTransitionDto {
    to: OrderStatus
    label: string
    requiresReason: boolean
    restoresStock: boolean
    /** Reached by recording a payment ("Registrar pago manualmente"), not by a plain button. */
    requiresPayment: boolean
    /** Reopens the order with a fresh deadline ("Reactivar pedido"); may lack stock. */
    reactivates: boolean
}

export interface RefundDto {
    status: RefundStatus
    label: string
    reference: string | null
    refundedAt: string | null
    refundedBy: { id: string; name: string } | null
}

export interface AdminOrderDto {
    id: string
    code: string
    status: OrderStatus
    statusLabel: string
    createdAt: string
    updatedAt: string
    paymentDueAt: string
    stockRestored: boolean
    /** Some payment proof arrived after the deadline (or once the order had expired). */
    latePayment: boolean
    /**
     * Products the order could not take back from stock; `resolvedAt` once acknowledged. While
     * open, `available` is the stock there is now and `stillShort` says whether confirming the
     * payment still needs an acknowledgement (otherwise the missing units are taken then).
     */
    stockConflict: LiveStockConflict | null
    /** Asked when an order with a payment was cancelled; null otherwise. */
    refund: RefundDto | null
    /** The purchase receipt PDF can be downloaded (verified payment, not cancelled). */
    receiptAvailable: boolean
    customer: OrderCustomerDto
    items: AdminOrderItemDto[]
    totals: OrderTotalsDto
    payments: AdminPaymentDto[]
    history: AdminHistoryEntryDto[]
    notes: AdminNoteDto[]
    allowedTransitions: AllowedTransitionDto[]
}

export interface AdminOrderListItemDto {
    code: string
    status: OrderStatus
    statusLabel: string
    createdAt: string
    paymentDueAt: string
    customerName: string
    customerPhone: string
    deliveryMethod: DeliveryMethod
    totalUsd: number
    totalBs: number
    itemCount: number
    latePayment: boolean
    /** An unresolved stock conflict still short now (confirming the payment needs an acknowledgement). */
    stockConflict: boolean
    refundStatus: RefundStatus | null
    /** The newest payment proof, if any. */
    latestPayment:
        (PaymentFlagsDto & { reference: string; amountBs: number; status: PaymentStatus }) | null
}

/** History notes the customer may read (the rest may be internal wording). */
const PUBLIC_NOTE_STATUSES: readonly OrderStatus[] = ['PAGO_RECHAZADO', 'CANCELADO', 'ENVIADO']

const ACTOR_NAMES: Record<ActorKind, string> = {
    admin: 'Administración',
    customer: 'Cliente',
    system: 'Sistema',
    telegram: 'Telegram',
}

export function paymentFlags(
    payment: Pick<OrderPayment, 'amountBs' | 'expectedBs' | 'duplicateReference'>,
): PaymentFlagsDto {
    const difference = amountDifferenceBs(payment.amountBs, payment.expectedBs)
    return {
        duplicateReference: payment.duplicateReference,
        amountMismatch: difference !== 0,
        amountDifferenceBs: difference,
    }
}

export function sortByDate<T extends { createdAt: Date }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

function toCustomer(order: Order): OrderCustomerDto {
    return {
        fullName: order.customerName,
        email: order.customerEmail,
        phone: order.customerPhone,
        city: order.city,
        address: order.address,
        deliveryMethod: order.deliveryMethod,
        notes: order.notes,
    }
}

function toItem(item: OrderItem): OrderItemDto {
    return {
        productId: item.productId,
        productName: item.productName,
        productSlug: item.productSlug,
        variantId: item.variantId,
        variantLabel: item.variantLabel,
        imageUrl: item.imageUrl,
        unitPriceUsd: item.unitPriceUsd,
        quantity: item.quantity,
        lineTotalUsd: item.lineTotalUsd,
    }
}

function toAdminItem(item: OrderItem): AdminOrderItemDto {
    return { ...toItem(item), id: item.id }
}

function toTotals(order: Order): OrderTotalsDto {
    return {
        subtotalUsd: order.subtotalUsd,
        shippingUsd: order.shippingUsd,
        totalUsd: order.totalUsd,
        totalBs: order.totalBs,
        exchangeRate: order.exchangeRate,
        exchangeRateDate: order.exchangeRateDate,
        exchangeRateSource: order.exchangeRateSource,
        exchangeRateSourceLabel: RATE_SOURCE_LABELS[order.exchangeRateSource],
    }
}

function toPublicPayment(payment: OrderPayment): PublicPaymentDto {
    return {
        id: payment.id,
        status: payment.status,
        reference: payment.reference,
        payerBankCode: payment.payerBankCode,
        payerBankName: payment.payerBankName,
        amountBs: payment.amountBs,
        paidOn: payment.paidOn,
        hasProof: payment.hasProof,
        rejectionReason: payment.rejectionReason,
        createdAt: payment.createdAt.toISOString(),
    }
}

function sortedItems(order: Order): OrderItem[] {
    return [...(order.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * A payment proof may be recorded while the order waits for one, even after the deadline or
 * once expired (flagged as late): a real Pago Móvil is never refused. CANCELADO stays closed.
 */
export function canSubmitPayment(order: Pick<Order, 'status'>): boolean {
    return PAYABLE_STATUSES.includes(order.status)
}

/**
 * A payment is late when the day the customer says they paid (Caracas calendar day) comes after
 * the day the deadline falls on. When the proof is uploaded does not matter: paying on time and
 * uploading later is fine, since the Bs amount was paid at the rate it was quoted at.
 */
export function isLatePayment(order: Pick<Order, 'paymentDueAt'>, paidOn: string): boolean {
    return paidOn > caracasDay(order.paymentDueAt)
}

/** `label` names each status (the catalog's admin label, see `OrderStatusCatalogService`). */
export function toPublicOrder(
    order: Order,
    pagoMovil: PaymentContent | null,
    label: StatusLabeler,
): PublicOrderDto {
    return {
        code: order.code,
        status: order.status,
        statusLabel: label(order.status),
        createdAt: order.createdAt.toISOString(),
        paymentDueAt: order.paymentDueAt.toISOString(),
        canSubmitPayment: canSubmitPayment(order),
        receiptAvailable: hasReceipt(order, order.payments ?? []),
        customer: toCustomer(order),
        items: sortedItems(order).map(toItem),
        totals: toTotals(order),
        pagoMovil,
        payments: sortByDate(order.payments ?? [])
            .reverse()
            .map(toPublicPayment),
        history: sortByDate(order.history ?? []).map((entry) => ({
            status: entry.toStatus,
            label: label(entry.toStatus),
            at: entry.createdAt.toISOString(),
            note: PUBLIC_NOTE_STATUSES.includes(entry.toStatus) ? entry.note : null,
        })),
    }
}

function toAdminHistory(entry: OrderStatusHistory, label: StatusLabeler): AdminHistoryEntryDto {
    return {
        from: entry.fromStatus,
        to: entry.toStatus,
        label: label(entry.toStatus),
        actor: entry.actorType,
        actorName: entry.actorUser?.name ?? ACTOR_NAMES[entry.actorType],
        note: entry.note,
        at: entry.createdAt.toISOString(),
    }
}

function toAdminNote(note: OrderNote): AdminNoteDto {
    return {
        id: note.id,
        body: note.body,
        author: note.author ? { id: note.author.id, name: note.author.name } : null,
        createdAt: note.createdAt.toISOString(),
    }
}

export function proofPath(code: string, paymentId: string): string {
    return `/admin/orders/${encodeURIComponent(code)}/payments/${encodeURIComponent(paymentId)}/proof`
}

/** `stockConflict`: the order's conflict refreshed with the current stock (`liveStockConflict`). */
export function toAdminOrder(
    order: Order,
    transitions: readonly TransitionRule[],
    label: StatusLabeler,
    stockConflict: LiveStockConflict | null,
): AdminOrderDto {
    return {
        id: order.id,
        code: order.code,
        status: order.status,
        statusLabel: label(order.status),
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        paymentDueAt: order.paymentDueAt.toISOString(),
        stockRestored: order.stockRestored,
        latePayment: order.latePayment,
        stockConflict,
        receiptAvailable: hasReceipt(order, order.payments ?? []),
        refund: order.refundStatus
            ? {
                  status: order.refundStatus,
                  label: REFUND_STATUS_LABELS[order.refundStatus],
                  reference: order.refundReference ?? null,
                  refundedAt: order.refundedAt?.toISOString() ?? null,
                  refundedBy: order.refundedBy
                      ? { id: order.refundedBy.id, name: order.refundedBy.name }
                      : null,
              }
            : null,
        customer: toCustomer(order),
        items: sortedItems(order).map(toAdminItem),
        totals: toTotals(order),
        payments: sortByDate(order.payments ?? [])
            .reverse()
            .map((payment) => ({
                ...toPublicPayment(payment),
                ...paymentFlags(payment),
                late: payment.late,
                source: payment.source,
                recordedBy: payment.recordedBy
                    ? { id: payment.recordedBy.id, name: payment.recordedBy.name }
                    : null,
                payerPhone: payment.payerPhone,
                payerIdNumber: payment.payerIdNumber,
                expectedBs: payment.expectedBs,
                proofPath: payment.hasProof ? proofPath(order.code, payment.id) : null,
                reviewedAt: payment.reviewedAt?.toISOString() ?? null,
                reviewedBy: payment.reviewedBy
                    ? { id: payment.reviewedBy.id, name: payment.reviewedBy.name }
                    : null,
            })),
        history: sortByDate(order.history ?? []).map((entry) => toAdminHistory(entry, label)),
        notes: sortByDate(order.adminNotes ?? [])
            .reverse()
            .map(toAdminNote),
        allowedTransitions: transitions.map((rule) => ({
            to: rule.to,
            label: label(rule.to),
            requiresReason: rule.requiresReason === true,
            restoresStock: rule.restoresStock === true && !order.stockRestored,
            requiresPayment: rule.requiresPayment === true,
            reactivates: rule.reactivates === true,
        })),
    }
}
