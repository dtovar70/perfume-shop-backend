import {
    Check,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryColumn,
    UpdateDateColumn,
    type Relation,
} from 'typeorm'
import { CATALOG_CODE_MAX_LENGTH } from '../../catalogs/dto/field-names.js'
import { OrderStatusDefinition } from '../../catalogs/entities/order-status-definition.entity.js'
import { TEXT_INPUT_MAX_LENGTH } from '../../common/validation/text-limits.js'
import { ORDER_LIMITS } from '../dto/field-names.js'
import { User } from '../../auth/entities/user.entity.js'
import { decimalTransformer } from '../../database/decimal.transformer.js'
import { ExchangeRate } from '../../exchange-rate/entities/exchange-rate.entity.js'
import type { RateSource } from '../../exchange-rate/providers/rate-provider.js'
import type { DeliveryMethod } from '../order-pricing.js'
import {
    ORDER_STATUSES,
    REFUND_STATUSES,
    type OrderStatus,
    type RefundStatus,
} from '../order-status.js'
import { OrderAccessLink } from './order-access-link.entity.js'
import { OrderItem } from './order-item.entity.js'
import { OrderNote } from './order-note.entity.js'
import { OrderPayment } from './order-payment.entity.js'
import { OrderStatusHistory } from './order-status-history.entity.js'

/** One variant (or product without variants) that could not be fully taken out of stock again. */
export interface StockConflictLine {
    /** Null when the product was deleted after the order was placed. */
    productId: string | null
    /**
     * The ordered variant (it may have been deleted since); null for a product without
     * variants. Absent on lines recorded before stock was kept per variant.
     */
    variantId?: string | null
    productName: string
    /** Snapshot of the ordered variant's label; absent on lines recorded before, like `variantId`. */
    variantLabel?: string | null
    /** Units the order needs (every line of that variant). */
    requested: number
    /** Units in stock when the conflict was detected. */
    available: number
    /** Units this order actually holds (taken from stock); the rest is missing. */
    reserved: number
}

export interface StockConflict {
    detectedAt: string
    lines: StockConflictLine[]
    /** When an admin confirmed the payment acknowledging the missing stock. */
    resolvedAt: string | null
    resolvedById: string | null
}

/**
 * A guest order. Prices, shipping and the BCV rate are computed by the server and frozen here
 * when the order is created; the items keep their own product snapshots.
 */

@Entity({ name: 'orders' })
@Index('orders_code_key', ['code'], { unique: true })
@Index('orders_status_idx', ['status'])
@Index('orders_created_at_idx', ['createdAt'])
@Index('orders_refund_pending_idx', ['createdAt'], { where: `"refund_status" = 'PENDIENTE'` })
@Index('orders_idempotency_key_key', ['idempotencyKey'], { unique: true })
@Check('orders_idempotency_check', `("idempotency_key" IS NULL) = ("idempotency_hash" IS NULL)`)
@Check(
    'orders_status_check',
    `"status" IN (${ORDER_STATUSES.map((status) => `'${status}'`).join(', ')})`,
)
@Check('orders_delivery_method_check', `"delivery_method" IN ('delivery', 'pickup')`)
@Check('orders_notes_length_check', `char_length("notes") <= ${ORDER_LIMITS.notes}`)
@Check(
    'orders_refund_status_check',
    `"refund_status" IN (${REFUND_STATUSES.map((status) => `'${status}'`).join(', ')})`,
)
export class Order {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'orders_pkey' })
    id: string

    /** Human-friendly and sequential: "KZ-000123" (from the `order_code_seq` sequence). */
    @Column({ type: 'text' })
    code: string

    /** `varchar(40)`, like the `order_statuses.code` it references. */
    @Column({ type: 'varchar', length: CATALOG_CODE_MAX_LENGTH })
    status: OrderStatus

    /**
     * The status's catalog row (labels, tone). The foreign key keeps every order on a known
     * status; the CHECK above still pins the column to the codes the workflow knows.
     */
    @ManyToOne(() => OrderStatusDefinition, {
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        nullable: false,
    })
    @JoinColumn({ name: 'status', foreignKeyConstraintName: 'orders_status_fkey' })
    statusDefinition: Relation<OrderStatusDefinition>

    @Column({ name: 'customer_name', type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    customerName: string

    @Column({ name: 'customer_email', type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    customerEmail: string

    @Column({ name: 'customer_phone', type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    customerPhone: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    city: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    address: string

    @Column({ name: 'delivery_method', type: 'text' })
    deliveryMethod: DeliveryMethod

    /** Customer's notes for the workshop ("" when none). */
    @Column({ type: 'text', default: '' })
    notes: string

    @Column({
        name: 'subtotal_usd',
        type: 'numeric',
        precision: 10,
        scale: 2,
        transformer: decimalTransformer,
    })
    subtotalUsd: number

    @Column({
        name: 'shipping_usd',
        type: 'numeric',
        precision: 10,
        scale: 2,
        transformer: decimalTransformer,
    })
    shippingUsd: number

    @Column({
        name: 'total_usd',
        type: 'numeric',
        precision: 10,
        scale: 2,
        transformer: decimalTransformer,
    })
    totalUsd: number

    /** Snapshot of the BCV rate used (Bs per USD). */
    @Column({
        name: 'exchange_rate',
        type: 'numeric',
        precision: 12,
        scale: 4,
        transformer: decimalTransformer,
    })
    exchangeRate: number

    @Column({ name: 'exchange_rate_source', type: 'text' })
    exchangeRateSource: RateSource

    @Column({ name: 'exchange_rate_date', type: 'date' })
    exchangeRateDate: string

    @Column({ name: 'exchange_rate_id', type: 'text', nullable: true })
    exchangeRateId: string | null

    @ManyToOne(() => ExchangeRate, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({
        name: 'exchange_rate_id',
        foreignKeyConstraintName: 'orders_exchange_rate_id_fkey',
    })
    exchangeRateRow: Relation<ExchangeRate> | null

    /** `total_usd` x `exchange_rate`, rounded to 2 decimals: the exact amount to pay. */
    @Column({
        name: 'total_bs',
        type: 'numeric',
        precision: 14,
        scale: 2,
        transformer: decimalTransformer,
    })
    totalBs: number

    /** Unpaid orders expire at this instant (created + ORDER_PAYMENT_WINDOW_HOURS). */
    @Column({ name: 'payment_due_at', type: 'timestamptz', precision: 3 })
    paymentDueAt: Date

    /** Set once the stock was put back (cancelled or expired), so it never happens twice. */
    @Column({ name: 'stock_restored', type: 'boolean', default: false })
    stockRestored: boolean

    /** A payment proof arrived after the deadline (or once the order had expired). */
    @Column({ name: 'late_payment', type: 'boolean', default: false })
    latePayment: boolean

    /**
     * Set when the order took its stock back (late payment on an expired order, forced
     * reactivation) and some product did not have enough. The admin must acknowledge it to
     * confirm the payment. Null when there is no conflict.
     */
    @Column({ name: 'stock_conflict', type: 'jsonb', nullable: true })
    stockConflict: StockConflict | null

    /** Asked when an order with a pending or verified payment is cancelled. */
    @Column({ name: 'refund_status', type: 'text', nullable: true })
    refundStatus: RefundStatus | null

    /** Bank reference of the refund, when the admin gave one. */
    @Column({
        name: 'refund_reference',
        type: 'varchar',
        length: TEXT_INPUT_MAX_LENGTH,
        nullable: true,
    })
    refundReference: string | null

    @Column({ name: 'refunded_at', type: 'timestamptz', precision: 3, nullable: true })
    refundedAt: Date | null

    @Column({ name: 'refunded_by', type: 'text', nullable: true })
    refundedById: string | null

    @ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'refunded_by', foreignKeyConstraintName: 'orders_refunded_by_fkey' })
    refundedBy: Relation<User> | null

    /**
     * The checkout's `Idempotency-Key` header (unique while set), so a retried checkout returns
     * this order instead of creating another. Null without the header, or once freed (24 h).
     */
    @Column({ name: 'idempotency_key', type: 'varchar', length: 64, nullable: true })
    idempotencyKey: string | null

    /** SHA-256 (hex) of the checkout body sent with that key (see `checkoutRequestHash`). */
    @Column({ name: 'idempotency_hash', type: 'varchar', length: 64, nullable: true })
    idempotencyHash: string | null

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
    createdAt: Date

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', precision: 3 })
    updatedAt: Date

    @OneToMany(() => OrderItem, (item) => item.order)
    items: Relation<OrderItem[]>

    @OneToMany(() => OrderPayment, (payment) => payment.order)
    payments: Relation<OrderPayment[]>

    @OneToMany(() => OrderStatusHistory, (entry) => entry.order)
    history: Relation<OrderStatusHistory[]>

    @OneToMany(() => OrderNote, (note) => note.order)
    adminNotes: Relation<OrderNote[]>

    /** Private links to the customer's page (`order_access_links`); only token hashes. */
    @OneToMany(() => OrderAccessLink, (link) => link.order)
    accessLinks: Relation<OrderAccessLink[]>
}
