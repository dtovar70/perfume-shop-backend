import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, In, type EntityManager } from 'typeorm'
import { OrderStatusCatalogService } from '../catalogs/order-status-catalog.service.js'
import type { Env } from '../config/env.schema.js'
import { newId } from '../database/id.js'
import { OutboxService } from '../outbox/outbox.service.js'
import {
    changeStock,
    lockStock,
    resolveStockUnit,
    stockItemName,
    stockUnitKey,
    type LockedStock,
    type StockChange,
} from '../products/product-stock.js'
import { OrderItem } from './entities/order-item.entity.js'
import { OrderPayment } from './entities/order-payment.entity.js'
import { OrderStatusHistory } from './entities/order-status-history.entity.js'
import { Order, type StockConflict, type StockConflictLine } from './entities/order.entity.js'
import {
    checkTransition,
    invalidTransitionMessage,
    type OrderActor,
    type OrderStatus,
    type RefundStatus,
} from './order-status.js'
import {
    ORDER_EVENTS,
    type OrderCreatedEvent,
    type OrderPaymentSubmittedEvent,
    type OrderRefundUpdatedEvent,
    type OrderStatusChangedEvent,
} from './orders.events.js'
import { liveStockConflict, stockConflictProductIds } from './stock-conflict.js'

export const ORDER_NOT_FOUND = 'No encontramos el pedido.'
/** 409 of a reactivation without enough stock (`lines` lists what is missing). */
export const STOCK_INSUFFICIENT = 'STOCK_INSUFFICIENT'
/** 400 when confirming a payment of an order with a stock conflict without acknowledging it. */
export const STOCK_CONFLICT_UNACKNOWLEDGED = 'STOCK_CONFLICT_UNACKNOWLEDGED'

/** Events collected inside a transaction and emitted once it commits. */
export type PendingOrderEvent =
    | { name: typeof ORDER_EVENTS.created; payload: OrderCreatedEvent }
    | { name: typeof ORDER_EVENTS.paymentSubmitted; payload: OrderPaymentSubmittedEvent }
    | { name: typeof ORDER_EVENTS.statusChanged; payload: OrderStatusChangedEvent }
    | { name: typeof ORDER_EVENTS.refundUpdated; payload: OrderRefundUpdatedEvent }

/** Everything a transition may need besides its target. */
export interface TransitionOptions {
    /** Reason (rejections, cancellations) or note (shipping). */
    note?: string | null
    /** Set by the payment recorders only: the order moves because a proof was just recorded. */
    paymentRecorded?: boolean
    /** The admin confirms a payment knowing the order lacks stock (required in that case). */
    acknowledgeStockConflict?: boolean
    /** Reactivate even without enough stock; what is missing is flagged as a stock conflict. */
    forceStock?: boolean
    /** Required when cancelling an order with a pending or verified payment. */
    refundStatus?: RefundStatus
    refundReference?: string | null
}

type ReserveResult =
    { ok: true; conflict: StockConflict | null } | { ok: false; lines: StockConflictLine[] }

export function actorUserId(actor: OrderActor): string | null {
    if (actor.kind === 'admin') return actor.userId
    if (actor.kind === 'telegram') return actor.userId ?? null
    return null
}

function badRequest(
    field: string,
    message: string,
    error: string,
    code?: string,
    extra: Record<string, unknown> = {},
) {
    return new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        ...(code ? { code } : {}),
        message,
        details: [{ field, errors: [error] }],
        ...extra,
    })
}

function units(count: number): string {
    return count === 1 ? '1 unidad' : `${count} unidades`
}

/** "Yara – 100 ml" (just the product name on lines without a variant). */
export function stockLineName(line: StockConflictLine): string {
    return stockItemName(line.productName, line.variantLabel)
}

/** "«Yara – 100 ml» pidió 3, hay 1" for each line. */
export function describeStockLines(lines: readonly StockConflictLine[]): string {
    return lines
        .map((line) => `«${stockLineName(line)}» pidió ${line.requested}, hay ${line.available}`)
        .join('; ')
}

/**
 * The one place where an order changes status. The admin HTTP API, the payment-proof upload,
 * the expiry job and the future Telegram bot all go through `transition()` (or, inside an
 * existing transaction, `applyTransition()`), so the allowed-transition map, the side effects
 * (stock, payment review, refunds) and the history/event trail can never diverge.
 */
@Injectable()
export class OrderStatusService {
    private readonly logger = new Logger(OrderStatusService.name)
    private readonly paymentWindowMs: number

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly events: EventEmitter2,
        private readonly catalog: OrderStatusCatalogService,
        private readonly outbox: OutboxService,
        config: ConfigService<Env, true>,
    ) {
        this.paymentWindowMs = config.get('ORDER_PAYMENT_WINDOW_HOURS', { infer: true }) * 3_600_000
    }

    /** Deadline of an order created (or reactivated) at `from`. */
    paymentDeadline(from: Date): Date {
        return new Date(from.getTime() + this.paymentWindowMs)
    }

    /**
     * Moves the order `code` to `to` on behalf of `actor`. Throws 404 (unknown order), 409
     * (transition not allowed from the current status, or not enough stock to reactivate), 403
     * (role may not do it) or 400 (a reason, the refund answer or the stock acknowledgement is
     * missing). Emits `order.status_changed` after commit. A plain string is the note.
     */
    async transition(
        code: string,
        to: OrderStatus,
        actor: OrderActor,
        options?: string | null | TransitionOptions,
    ): Promise<Order> {
        const normalized: TransitionOptions =
            typeof options === 'object' && options !== null ? options : { note: options ?? null }
        const pending: PendingOrderEvent[] = []
        const order = await this.dataSource.transaction(async (manager) => {
            const locked = await this.lockByCode(manager, code)
            if (!locked) throw new NotFoundException(ORDER_NOT_FOUND)
            await this.applyTransition(manager, locked, to, actor, normalized, pending)
            // Same transaction as the status change (see recordEvents).
            await this.recordEvents(manager, pending)
            return locked
        })
        this.emit(pending)
        return order
    }

    /** Loads the order row with a `FOR UPDATE` lock (inside a transaction). */
    lockByCode(manager: EntityManager, code: string): Promise<Order | null> {
        return manager
            .createQueryBuilder(Order, 'o')
            .setLock('pessimistic_write')
            .where('o.code = :code', { code })
            .getOne()
    }

    /**
     * Validates and applies one transition inside the caller's transaction. `order` must have
     * been loaded with `lockByCode` in that same transaction; it is updated in place. Every
     * check runs before the first write.
     */
    async applyTransition(
        manager: EntityManager,
        order: Order,
        to: OrderStatus,
        actor: OrderActor,
        options: TransitionOptions,
        pending: PendingOrderEvent[],
    ): Promise<void> {
        const from = order.status
        const check = checkTransition(from, to, actor)
        if (!check.ok) {
            if (check.reason === 'forbidden') {
                throw new ForbiddenException('No tienes permisos para realizar esta acción.')
            }
            throw new ConflictException(
                invalidTransitionMessage(from, to, await this.catalog.labeler()),
            )
        }
        const { rule } = check
        const trimmedNote = options.note?.trim() || null
        if (rule.requiresReason && !trimmedNote) {
            throw badRequest(
                'note',
                'Escribe el motivo para continuar.',
                'El motivo es obligatorio.',
            )
        }
        if (rule.requiresPayment && !options.paymentRecorded) {
            throw new ConflictException(
                'Para pasar el pedido a verificación, registra el pago con sus datos.',
            )
        }
        if (rule.requiresNoVerifiedPayment) {
            const verified = await manager.find(OrderPayment, {
                where: { orderId: order.id, status: 'VERIFICADO' },
                select: { id: true },
            })
            if (verified.length) {
                throw new ConflictException(
                    'Este pedido tuvo un pago verificado, así que no se puede reactivar.',
                )
            }
        }
        const refund = to === 'CANCELADO' ? await this.refundAnswer(manager, order, options) : null
        const conflictToResolve =
            to === 'PAGO_VERIFICADO' && order.stockConflict && !order.stockConflict.resolvedAt
                ? order.stockConflict
                : null
        // The conflict is a snapshot: decide with the stock there is now, locked here and kept
        // locked until `takeMissingStock` takes from these same rows (the owner may have
        // restocked since, and nobody can take it in between).
        const conflictStock = conflictToResolve
            ? await lockStock(manager, stockConflictProductIds(conflictToResolve))
            : null
        if (conflictToResolve && conflictStock && options.acknowledgeStockConflict !== true) {
            const live = liveStockConflict(conflictToResolve, conflictStock)
            if (live.stillShort) {
                const short = live.lines.filter((line) => line.stillShort)
                throw badRequest(
                    'acknowledgeStockConflict',
                    `Falta stock para este pedido (${describeStockLines(short)}). Confirma que lo entiendes para continuar.`,
                    'Confirma que entiendes que falta stock.',
                    STOCK_CONFLICT_UNACKNOWLEDGED,
                    { lines: short },
                )
            }
        }

        const now = new Date()
        const reviewerId = actorUserId(actor)
        const changes: Partial<Order> = { status: to }
        const systemNotes: string[] = []

        // Strict reservation first: it is the only step that can still refuse (409).
        if (rule.reservesStock && order.stockRestored) {
            const reserved = await this.reserveStock(manager, order.id, now, {
                strict: rule.reactivates === true && options.forceStock !== true,
            })
            if (!reserved.ok) {
                throw new ConflictException({
                    statusCode: 409,
                    error: 'Conflict',
                    code: STOCK_INSUFFICIENT,
                    message: `No hay stock suficiente para reactivar el pedido: ${describeStockLines(reserved.lines)}.`,
                    lines: reserved.lines,
                })
            }
            changes.stockRestored = false
            changes.stockConflict = reserved.conflict
            if (reserved.conflict) {
                systemNotes.push(
                    `Stock insuficiente: ${describeStockLines(reserved.conflict.lines)}.`,
                )
            }
        }
        if (rule.reactivates) {
            changes.paymentDueAt = this.paymentDeadline(now)
            systemNotes.unshift('Pedido reactivado con un nuevo plazo de pago.')
        }

        if (to === 'PAGO_VERIFICADO') {
            await this.reviewPendingPayment(manager, order.id, {
                status: 'VERIFICADO',
                reviewedAt: now,
                reviewedById: reviewerId,
            })
        } else if (
            to === 'PAGO_RECHAZADO' ||
            (to === 'CANCELADO' && from === 'PENDIENTE_VERIFICACION')
        ) {
            await this.reviewPendingPayment(manager, order.id, {
                status: 'RECHAZADO',
                rejectionReason: trimmedNote,
                reviewedAt: now,
                reviewedById: reviewerId,
            })
        }

        if (conflictToResolve && conflictStock) {
            const resolved = await this.takeMissingStock(
                manager,
                conflictToResolve,
                conflictStock,
                now,
                reviewerId,
            )
            changes.stockConflict = resolved
            const missing = resolved.lines.filter((line) => line.reserved < line.requested)
            systemNotes.push(
                missing.length
                    ? `Pago confirmado con stock insuficiente: ${missing
                          .map(
                              (line) =>
                                  `«${stockLineName(line)}» faltan ${units(line.requested - line.reserved)}`,
                          )
                          .join('; ')}.`
                    : 'Pago confirmado; el stock que faltaba ya estaba disponible.',
            )
        }

        if (rule.restoresStock && !order.stockRestored) {
            await this.restoreStock(manager, order)
            changes.stockRestored = true
            // The order holds nothing now; a later reservation starts from scratch.
            changes.stockConflict = null
        }

        if (refund) Object.assign(changes, refund.changes(now, reviewerId))

        await manager.update(Order, { id: order.id }, changes)
        const historyNote = systemNotes.length
            ? [trimmedNote && !/[.!?]$/.test(trimmedNote) ? `${trimmedNote}.` : trimmedNote]
                  .concat(systemNotes)
                  .filter(Boolean)
                  .join(' ')
            : trimmedNote
        await manager.insert(OrderStatusHistory, {
            id: newId(),
            orderId: order.id,
            fromStatus: from,
            toStatus: to,
            actorType: actor.kind,
            actorUserId: reviewerId,
            note: historyNote,
            createdAt: now,
        })

        Object.assign(order, changes)
        pending.push({
            name: ORDER_EVENTS.statusChanged,
            payload: {
                orderId: order.id,
                code: order.code,
                from,
                to,
                actor: actor.kind,
                actorUserId: reviewerId,
                note: historyNote,
                changedAt: now.toISOString(),
            },
        })
        if (refund && order.refundStatus) {
            pending.push({
                name: ORDER_EVENTS.refundUpdated,
                payload: {
                    orderId: order.id,
                    code: order.code,
                    refundStatus: order.refundStatus,
                    reference: order.refundReference,
                    actorUserId: reviewerId,
                    updatedAt: now.toISOString(),
                },
            })
        }
    }

    /**
     * Writes the outbox rows (customer emails, Telegram messages) of the events collected in a
     * transaction, with that transaction: they exist if and only if the change commits. Every
     * order transaction calls it last, so a notification can never be lost to a crash or a
     * provider outage after the commit (the worker retries it).
     */
    recordEvents(manager: EntityManager, pending: readonly PendingOrderEvent[]): Promise<void> {
        return this.outbox.enqueue(manager, pending)
    }

    /**
     * Emits events collected during a committed transaction, for in-process reactions (cache
     * invalidation, waking the outbox worker). A failing listener is logged.
     */
    emit(pending: readonly PendingOrderEvent[]): void {
        for (const event of pending) {
            try {
                this.events.emit(event.name, event.payload)
            } catch (error) {
                this.logger.error(`Listener of ${event.name} failed`, error as Error)
            }
        }
    }

    /**
     * Cancelling an order with a pending or verified payment must say whether money has to be
     * given back. Returns the columns to write (null when the order never had such a payment).
     */
    private async refundAnswer(
        manager: EntityManager,
        order: Order,
        options: TransitionOptions,
    ): Promise<{ changes: (now: Date, userId: string | null) => Partial<Order> } | null> {
        const live = await manager.find(OrderPayment, {
            where: { orderId: order.id, status: In(['PENDIENTE', 'VERIFICADO']) },
            select: { id: true },
        })
        if (!live.length) return null
        const status = options.refundStatus
        if (!status) {
            throw badRequest(
                'refundStatus',
                'Indica si hay que devolver dinero al cliente.',
                'Indica si hay que devolver dinero al cliente.',
            )
        }
        const reference = options.refundReference?.trim() || null
        return {
            changes: (now, userId) => ({
                refundStatus: status,
                refundReference: status === 'REEMBOLSADO' ? reference : null,
                refundedAt: status === 'REEMBOLSADO' ? now : null,
                refundedById: status === 'REEMBOLSADO' ? userId : null,
            }),
        }
    }

    private async reviewPendingPayment(
        manager: EntityManager,
        orderId: string,
        changes: Partial<OrderPayment>,
    ): Promise<void> {
        await manager.update(OrderPayment, { orderId, status: 'PENDIENTE' }, changes)
    }

    /**
     * Takes the order's quantities out of stock again, with the same row locks as checkout,
     * per variant (`order_items.variant_id`). `strict`: all or nothing (reactivation without
     * force). Otherwise every variant gives what it has, never going below 0, and the shortfall
     * is returned as a stock conflict. A line whose product or variant was deleted gives nothing
     * and shows up as a conflict line.
     */
    private async reserveStock(
        manager: EntityManager,
        orderId: string,
        now: Date,
        { strict }: { strict: boolean },
    ): Promise<ReserveResult> {
        const items = await manager.find(OrderItem, {
            where: { orderId },
            select: {
                productId: true,
                variantId: true,
                productName: true,
                variantLabel: true,
                quantity: true,
                sortOrder: true,
            },
        })
        const locked = await lockStock(
            manager,
            items.flatMap((item) => (item.productId ? [item.productId] : [])),
        )
        const wanted = new Map<string, StockConflictLine>()
        for (const item of [...items].sort((a, b) => a.sortOrder - b.sortOrder)) {
            const unit = resolveStockUnit(locked, item.productId, item.variantId)
            const key = unit
                ? stockUnitKey(unit.productId, unit.variantId)
                : `missing:${item.productId ?? item.productName}:${item.variantId ?? item.variantLabel ?? ''}`
            const line = wanted.get(key)
            if (line) line.requested += item.quantity
            else {
                wanted.set(key, {
                    productId: item.productId,
                    variantId: item.variantId,
                    productName: item.productName,
                    variantLabel: item.variantLabel,
                    requested: item.quantity,
                    available: unit?.available ?? 0,
                    reserved: 0,
                })
            }
        }
        const lines = [...wanted.values()].map((line) => ({
            ...line,
            reserved: Math.min(line.requested, line.available),
        }))
        const short = lines.filter((line) => line.available < line.requested)
        if (short.length && strict) return { ok: false, lines: short }

        await changeStock(
            manager,
            'take',
            lines.flatMap((line) => this.stockChange(line)),
        )
        return {
            ok: true,
            conflict: short.length
                ? {
                      detectedAt: now.toISOString(),
                      lines: short,
                      resolvedAt: null,
                      resolvedById: null,
                  }
                : null,
        }
    }

    /**
     * On confirmation: takes whatever of the missing stock is there now (never below 0), from
     * the rows the caller locked (`lockStock` over the conflict's products).
     */
    private async takeMissingStock(
        manager: EntityManager,
        conflict: StockConflict,
        locked: LockedStock,
        now: Date,
        userId: string | null,
    ): Promise<StockConflict> {
        const lines: StockConflictLine[] = []
        const taken: StockChange[] = []
        for (const line of conflict.lines) {
            // Lines recorded before stock was per variant only resolve for products without variants.
            const unit = resolveStockUnit(locked, line.productId, line.variantId ?? null)
            const take = unit ? Math.min(line.requested - line.reserved, unit.available) : 0
            if (unit && take > 0) {
                taken.push({ productId: unit.productId, variantId: unit.variantId, quantity: take })
            }
            lines.push({ ...line, reserved: line.reserved + Math.max(0, take) })
        }
        await changeStock(manager, 'take', taken)
        return { ...conflict, lines, resolvedAt: now.toISOString(), resolvedById: userId }
    }

    /**
     * Puts back what the order holds: every line's quantity into its variant, except for the
     * variants of a stock conflict, which only give back what was actually taken. A line whose
     * product or variant no longer exists gives nothing back (logged).
     */
    private async restoreStock(manager: EntityManager, order: Order): Promise<void> {
        const items = await manager.find(OrderItem, {
            where: { orderId: order.id },
            select: { productId: true, variantId: true, productName: true, quantity: true },
        })
        const locked = await lockStock(
            manager,
            items.flatMap((item) => (item.productId ? [item.productId] : [])),
        )
        const byUnit = new Map<string, StockChange>()
        for (const item of items) {
            const unit = resolveStockUnit(locked, item.productId, item.variantId)
            if (!unit) {
                if (item.productId) {
                    this.logger.warn(
                        `Order ${order.code}: ${item.quantity} of «${item.productName}» not restored, variant ${item.variantId ?? '(none)'} no longer exists`,
                    )
                }
                continue
            }
            const key = stockUnitKey(unit.productId, unit.variantId)
            const change = byUnit.get(key)
            if (change) change.quantity += item.quantity
            else {
                byUnit.set(key, {
                    productId: unit.productId,
                    variantId: unit.variantId,
                    quantity: item.quantity,
                })
            }
        }
        for (const line of order.stockConflict?.lines ?? []) {
            if (!line.productId) continue
            if (line.variantId !== undefined) {
                const change = byUnit.get(stockUnitKey(line.productId, line.variantId))
                if (change) change.quantity = line.reserved
                continue
            }
            // A line recorded before stock was per variant: cap the product's variants together.
            let left = line.reserved
            for (const change of byUnit.values()) {
                if (change.productId !== line.productId) continue
                change.quantity = Math.min(change.quantity, left)
                left -= change.quantity
            }
        }
        await changeStock(manager, 'give', [...byUnit.values()])
    }

    private stockChange(line: StockConflictLine): StockChange[] {
        if (!line.productId || line.reserved <= 0) return []
        return [
            {
                productId: line.productId,
                variantId: line.variantId ?? null,
                quantity: line.reserved,
            },
        ]
    }
}
