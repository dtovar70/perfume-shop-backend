import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { Brackets, DataSource, In } from 'typeorm'
import { OrderStatusCatalogService } from '../catalogs/order-status-catalog.service.js'
import type { AuthUser } from '../common/types/auth-user.js'
import { addDays, startOfCaracasDay } from '../common/utils/caracas-date.js'
import { ContentService } from '../content/content.service.js'
import { isPaymentConfigured } from '../content/content.types.js'
import { newId } from '../database/id.js'
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service.js'
import { readStock } from '../products/product-stock.js'
import type { Paginated } from '../products/product.mapper.js'
import {
    STORAGE_SERVICE,
    type PrivateFileAccess,
    type StorageService,
} from '../storage/storage.service.js'
import { ADMIN_ORDERS_PAGE_SIZE, type AdminOrderQueryDto } from './dto/admin-order-query.dto.js'
import type { SubmitPaymentDto } from './dto/submit-payment.dto.js'
import type { TransitionOrderDto } from './dto/transition-order.dto.js'
import { OrderItem } from './entities/order-item.entity.js'
import { OrderNote } from './entities/order-note.entity.js'
import { OrderPayment } from './entities/order-payment.entity.js'
import { Order } from './entities/order.entity.js'
import {
    paymentFlags,
    toAdminOrder,
    type AdminOrderDto,
    type AdminOrderListItemDto,
} from './order.mapper.js'
import {
    allowedTransitions,
    REFUND_STATUS_LABELS,
    ORDER_STATUSES,
    type OrderActor,
    type OrderStatus,
} from './order-status.js'
import {
    ORDER_NOT_FOUND,
    OrderStatusService,
    type PendingOrderEvent,
} from './order-status.service.js'
import { ORDER_EVENTS } from './orders.events.js'
import { OrdersService } from './orders.service.js'
import {
    liveStockConflict,
    readLiveStockConflict,
    stockConflictProductIds,
} from './stock-conflict.js'

export type OrderStatusCounts = Record<OrderStatus, number>

export interface AdminOrderListDto extends Paginated<AdminOrderListItemDto> {
    /** Orders per status for the current search and dates (ignoring the status filter). */
    counts: OrderStatusCounts
    countAll: number
    /** Cancelled orders whose money was not given back yet (same search and dates). */
    pendingRefunds: number
}

/** Cheap numbers for the admin nav badge and the orders page banners. */
export interface AdminOrdersSummaryDto {
    pendingVerification: number
    pendingPayment: number
    pendingRefunds: number
    paymentConfigured: boolean
    exchangeRate: {
        available: boolean
        isStale: boolean
        rate: number | null
        effectiveDate: string | null
    }
}

function adminActor(user: AuthUser): OrderActor {
    return { kind: 'admin', userId: user.id, role: user.role }
}

function emptyCounts(): OrderStatusCounts {
    return Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as OrderStatusCounts
}

/** Back-office reads and actions on orders. Status changes go through OrderStatusService. */
@Injectable()
export class AdminOrdersService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly statuses: OrderStatusService,
        private readonly catalog: OrderStatusCatalogService,
        private readonly content: ContentService,
        private readonly rates: ExchangeRateService,
        private readonly orders: OrdersService,
        @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    ) {}

    async list(query: AdminOrderQueryDto): Promise<AdminOrderListDto> {
        const page = query.page ?? 1
        const pageSize = query.pageSize ?? ADMIN_ORDERS_PAGE_SIZE
        const orders = this.dataSource.getRepository(Order)

        const filtered = () => {
            const qb = orders.createQueryBuilder('o')
            const search = query.search?.trim()
            if (search) {
                const digits = search.replace(/\D/g, '')
                qb.andWhere(
                    new Brackets((where) => {
                        where
                            .where('o.code ILIKE :like', { like: `%${search}%` })
                            .orWhere('o.customerName ILIKE :like')
                            .orWhere('o.customerEmail ILIKE :like')
                        if (digits.length >= 3) {
                            where
                                .orWhere(
                                    `regexp_replace(o.customer_phone, '\\D', '', 'g') LIKE :digits`,
                                    { digits: `%${digits}%` },
                                )
                                .orWhere(
                                    `EXISTS (SELECT 1 FROM "order_payments" p WHERE p."order_id" = o.id AND p."reference" LIKE :digits)`,
                                )
                        }
                    }),
                )
            }
            if (query.from) {
                qb.andWhere('o.createdAt >= :from', { from: startOfCaracasDay(query.from) })
            }
            if (query.to) {
                qb.andWhere('o.createdAt < :to', {
                    to: startOfCaracasDay(addDays(query.to, 1)),
                })
            }
            return qb
        }

        const countRows = await filtered()
            .select('o.status', 'status')
            .addSelect('COUNT(*)::int', 'count')
            .groupBy('o.status')
            .getRawMany<{ status: OrderStatus; count: number }>()
        const counts = emptyCounts()
        for (const row of countRows) counts[row.status] = Number(row.count)
        const countAll = Object.values(counts).reduce((sum, count) => sum + count, 0)
        const pendingRefunds = await filtered()
            .andWhere('o.refundStatus = :pendingRefund', { pendingRefund: 'PENDIENTE' })
            .getCount()

        const listQuery = filtered()
        if (query.status?.length) {
            listQuery.andWhere('o.status IN (:...statuses)', { statuses: query.status })
        }
        if (query.refundStatus) {
            listQuery.andWhere('o.refundStatus = :refundStatus', {
                refundStatus: query.refundStatus,
            })
        }
        const [rows, total] = await listQuery
            .orderBy('o.createdAt', 'DESC')
            .addOrderBy('o.code', 'DESC')
            .skip((page - 1) * pageSize)
            .take(pageSize)
            .getManyAndCount()

        const ids = rows.map((order) => order.id)
        const [payments, quantities] = ids.length
            ? await Promise.all([
                  this.dataSource.getRepository(OrderPayment).find({
                      where: { orderId: In(ids) },
                      order: { createdAt: 'DESC' },
                  }),
                  this.dataSource
                      .getRepository(OrderItem)
                      .createQueryBuilder('item')
                      .select('item.orderId', 'orderId')
                      .addSelect('SUM(item.quantity)::int', 'quantity')
                      .where('item.orderId IN (:...ids)', { ids })
                      .groupBy('item.orderId')
                      .getRawMany<{ orderId: string; quantity: number }>(),
              ])
            : [[], []]
        const latestPayment = new Map<string, OrderPayment>()
        for (const payment of payments) {
            if (!latestPayment.has(payment.orderId)) latestPayment.set(payment.orderId, payment)
        }
        const itemCounts = new Map(quantities.map((row) => [row.orderId, Number(row.quantity)]))
        // Open conflicts are snapshots: flag only the ones still short with today's stock.
        const openConflicts = rows.flatMap((order) =>
            order.stockConflict && !order.stockConflict.resolvedAt ? [order.stockConflict] : [],
        )
        const stock = openConflicts.length
            ? await readStock(
                  this.dataSource.manager,
                  openConflicts.flatMap(stockConflictProductIds),
              )
            : null
        const label = await this.catalog.labeler()

        return {
            items: rows.map((order) => {
                const payment = latestPayment.get(order.id)
                return {
                    code: order.code,
                    status: order.status,
                    statusLabel: label(order.status),
                    createdAt: order.createdAt.toISOString(),
                    paymentDueAt: order.paymentDueAt.toISOString(),
                    customerName: order.customerName,
                    customerPhone: order.customerPhone,
                    deliveryMethod: order.deliveryMethod,
                    totalUsd: order.totalUsd,
                    totalBs: order.totalBs,
                    itemCount: itemCounts.get(order.id) ?? 0,
                    latePayment: order.latePayment,
                    stockConflict: Boolean(
                        stock &&
                        order.stockConflict &&
                        liveStockConflict(order.stockConflict, stock).stillShort,
                    ),
                    refundStatus: order.refundStatus,
                    latestPayment: payment
                        ? {
                              reference: payment.reference,
                              amountBs: payment.amountBs,
                              status: payment.status,
                              ...paymentFlags(payment),
                          }
                        : null,
                }
            }),
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            counts,
            countAll,
            pendingRefunds,
        }
    }

    async summary(): Promise<AdminOrdersSummaryDto> {
        const rows = await this.dataSource
            .getRepository(Order)
            .createQueryBuilder('o')
            .select('o.status', 'status')
            .addSelect('COUNT(*)::int', 'count')
            .where('o.status IN (:...statuses)', {
                statuses: ['PENDIENTE_VERIFICACION', 'PENDIENTE_PAGO'],
            })
            .groupBy('o.status')
            .getRawMany<{ status: OrderStatus; count: number }>()
        const count = (status: OrderStatus) =>
            Number(rows.find((row) => row.status === status)?.count ?? 0)
        const [{ payment }, current, pendingRefunds] = await Promise.all([
            this.content.getAll(),
            this.rates.current(),
            this.dataSource.getRepository(Order).count({ where: { refundStatus: 'PENDIENTE' } }),
        ])
        return {
            pendingVerification: count('PENDIENTE_VERIFICACION'),
            pendingPayment: count('PENDIENTE_PAGO'),
            pendingRefunds,
            paymentConfigured: isPaymentConfigured(payment),
            exchangeRate: {
                available: current !== null && !current.isStale,
                isStale: current?.isStale ?? false,
                rate: current?.rate ?? null,
                effectiveDate: current?.effectiveDate ?? null,
            },
        }
    }

    async get(code: string, user: AuthUser): Promise<AdminOrderDto> {
        const order = await this.dataSource.getRepository(Order).findOne({
            where: { code },
            relations: {
                items: true,
                payments: { reviewedBy: true, recordedBy: true },
                history: { actorUser: true },
                adminNotes: { author: true },
                refundedBy: true,
            },
        })
        if (!order) throw new NotFoundException(ORDER_NOT_FOUND)
        const everVerified = (order.payments ?? []).some(
            (payment) => payment.status === 'VERIFICADO',
        )
        const rules = allowedTransitions(order.status, adminActor(user)).filter(
            (rule) => !(rule.requiresNoVerifiedPayment && everVerified),
        )
        const stockConflict = order.stockConflict
            ? await readLiveStockConflict(this.dataSource.manager, order.stockConflict)
            : null
        return toAdminOrder(order, rules, await this.catalog.labeler(), stockConflict)
    }

    async transition(
        code: string,
        dto: TransitionOrderDto,
        user: AuthUser,
    ): Promise<AdminOrderDto> {
        await this.statuses.transition(code, dto.to, adminActor(user), {
            note: dto.note,
            acknowledgeStockConflict: dto.acknowledgeStockConflict,
            forceStock: dto.forceStock,
            refundStatus: dto.refundStatus,
            refundReference: dto.refundReference,
        })
        return this.get(code, user)
    }

    /** "Registrar pago manualmente": a proof the customer sent by WhatsApp. */
    async recordPayment(
        code: string,
        dto: SubmitPaymentDto,
        file: Express.Multer.File | undefined,
        user: AuthUser,
    ): Promise<AdminOrderDto> {
        await this.orders.recordPayment(code, dto, file, {
            kind: 'admin',
            userId: user.id,
            role: user.role,
        })
        return this.get(code, user)
    }

    /** "Marcar reembolso realizado": only for a cancelled order with a pending refund. */
    async markRefunded(
        code: string,
        reference: string | undefined,
        user: AuthUser,
    ): Promise<AdminOrderDto> {
        const pending: PendingOrderEvent[] = []
        await this.dataSource.transaction(async (manager) => {
            const order = await this.statuses.lockByCode(manager, code)
            if (!order) throw new NotFoundException(ORDER_NOT_FOUND)
            if (order.refundStatus !== 'PENDIENTE') {
                throw new ConflictException('Este pedido no tiene un reembolso pendiente.')
            }
            const now = new Date()
            const trimmed = reference?.trim() || null
            await manager.update(
                Order,
                { id: order.id },
                {
                    refundStatus: 'REEMBOLSADO',
                    refundReference: trimmed,
                    refundedAt: now,
                    refundedById: user.id,
                },
            )
            await manager.insert(OrderNote, {
                id: newId(),
                orderId: order.id,
                authorId: user.id,
                body: `${REFUND_STATUS_LABELS.REEMBOLSADO}${trimmed ? ` (referencia ${trimmed})` : ''}.`,
                createdAt: now,
            })
            pending.push({
                name: ORDER_EVENTS.refundUpdated,
                payload: {
                    orderId: order.id,
                    code: order.code,
                    refundStatus: 'REEMBOLSADO',
                    reference: trimmed,
                    actorUserId: user.id,
                    updatedAt: now.toISOString(),
                },
            })
        })
        this.statuses.emit(pending)
        return this.get(code, user)
    }

    async addNote(code: string, body: string, user: AuthUser): Promise<AdminOrderDto> {
        const order = await this.dataSource
            .getRepository(Order)
            .findOne({ where: { code }, select: { id: true } })
        if (!order) throw new NotFoundException(ORDER_NOT_FOUND)
        await this.dataSource.getRepository(OrderNote).insert({
            id: newId(),
            orderId: order.id,
            authorId: user.id,
            body,
            createdAt: new Date(),
        })
        return this.get(code, user)
    }

    /** The private screenshot of one payment: a stream (local disk) or a signed redirect. */
    async paymentProof(code: string, paymentId: string): Promise<PrivateFileAccess> {
        const payment = await this.dataSource
            .getRepository(OrderPayment)
            .createQueryBuilder('payment')
            .addSelect('payment.proofKey')
            .innerJoin('payment.order', 'o')
            .where('payment.id = :paymentId', { paymentId })
            .andWhere('o.code = :code', { code })
            .getOne()
        const access = payment?.proofKey ? await this.storage.readPrivate(payment.proofKey) : null
        if (!access) throw new NotFoundException('Este pago no tiene captura.')
        return access
    }
}
