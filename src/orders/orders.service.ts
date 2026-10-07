import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, In, type EntityManager } from 'typeorm'
import { BanksService } from '../catalogs/banks.service.js'
import { MobilePrefixesService } from '../catalogs/mobile-prefixes.service.js'
import { OrderStatusCatalogService } from '../catalogs/order-status-catalog.service.js'
import { addDays, caracasDay } from '../common/utils/caracas-date.js'
import { ContentService } from '../content/content.service.js'
import { isPaymentConfigured, type PaymentContent } from '../content/content.types.js'
import { newId } from '../database/id.js'
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service.js'
import { ProductImage } from '../products/entities/product-image.entity.js'
import {
    changeStock,
    lockStock,
    stockItemName,
    stockUnitKey,
    type LockedStock,
} from '../products/product-stock.js'
import { detectImageType } from '../storage/image-type.js'
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.service.js'
import type { CreateOrderDto, OrderItemInputDto } from './dto/create-order.dto.js'
import { REFERENCE_DIGITS } from './dto/field-names.js'
import type { SubmitPaymentDto } from './dto/submit-payment.dto.js'
import { OrderItem } from './entities/order-item.entity.js'
import { OrderPayment } from './entities/order-payment.entity.js'
import { OrderStatusHistory } from './entities/order-status-history.entity.js'
import { Order } from './entities/order.entity.js'
import {
    canSubmitPayment,
    isLatePayment,
    toPublicOrder,
    type PublicOrderDto,
} from './order.mapper.js'
import { amountDifferenceBs, computeTotals, fromCents, unitPriceCents } from './order-pricing.js'
import { OrderAccessService } from './order-access.service.js'
import {
    checkoutRequestHash,
    IDEMPOTENCY_WINDOW_MS,
    idempotencyKeyReused,
    isIdempotencyKeyConflict,
} from './order-idempotency.js'
import { CLOSED_STATUSES, type OrderActor } from './order-status.js'
import {
    ORDER_NOT_FOUND,
    OrderStatusService,
    type PendingOrderEvent,
} from './order-status.service.js'
import { ORDER_EVENTS } from './orders.events.js'

export const PAYMENT_METHOD_UNAVAILABLE = 'PAYMENT_METHOD_UNAVAILABLE'
export const ORDER_ITEMS_INVALID = 'ORDER_ITEMS_INVALID'
const INVALID_BODY_MESSAGE = 'Los datos enviados no son válidos. Revisa los campos marcados.'

/** One problem with one cart line (returned so the storefront can mark and fix it). */
export interface OrderLineProblem {
    index: number
    productId: string
    variantId: string | null
    /**
     * Units this line can keep: what its variant (or product without variants) has left, minus
     * what earlier lines of the same variant take. 0 when the line cannot be bought.
     */
    available: number
    message: string
}

export interface CreatedOrderDto {
    code: string
    /** The only time the token is returned: the customer's link is `/pedido/<code>?t=<token>`. */
    accessToken: string
    order: PublicOrderDto
    /**
     * True when this is the answer to a retried checkout (same `Idempotency-Key` and body): no
     * new order was created and `accessToken` is a fresh link to the existing one.
     */
    replayed: boolean
}

interface CheckoutIdempotency {
    key: string
    hash: string
}

interface LockedCatalog extends LockedStock {
    firstImage: Map<string, string>
}

function units(count: number): string {
    return count === 1 ? '1 unidad' : `${count} unidades`
}

/** "Solo quedan 2 de «Yara – 100 ml»." / "«Yara – 100 ml» se agotó." */
function stockMessage(name: string, stock: number): string {
    if (stock <= 0) return `«${name}» se agotó.`
    const verb = stock === 1 ? 'Solo queda' : 'Solo quedan'
    return `${verb} ${units(stock)} de «${name}».`
}

function lineProblemsError(problems: OrderLineProblem[]): BadRequestException {
    return new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: ORDER_ITEMS_INVALID,
        message: 'Algunos productos de tu carrito cambiaron. Revisa los marcados.',
        details: problems.map((problem) => ({
            field: `items.${problem.index}`,
            errors: [problem.message],
        })),
        lines: problems,
    })
}

function fieldError(field: string, message: string): BadRequestException {
    return new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: INVALID_BODY_MESSAGE,
        details: [{ field, errors: [message] }],
    })
}

/**
 * Customer side of the orders: checkout (prices, shipping and the BCV rate are computed here,
 * never trusted from the client), the private order page and the Pago Móvil proof upload.
 */
@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name)

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly content: ContentService,
        private readonly rates: ExchangeRateService,
        private readonly statuses: OrderStatusService,
        private readonly catalog: OrderStatusCatalogService,
        private readonly banks: BanksService,
        private readonly mobilePrefixes: MobilePrefixesService,
        private readonly access: OrderAccessService,
        @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    ) {}

    /**
     * Checkout. With `idempotencyKey` (see order-idempotency.ts) a retry of the same request
     * returns the order created the first time instead of creating (and taking stock) again.
     */
    async create(dto: CreateOrderDto, idempotencyKey?: string): Promise<CreatedOrderDto> {
        const idempotency: CheckoutIdempotency | null = idempotencyKey
            ? { key: idempotencyKey, hash: checkoutRequestHash(dto) }
            : null
        // Before any other check: a retry must get its order even if, say, the rate went stale.
        if (idempotency) {
            const replayed = await this.replay(idempotency)
            if (replayed) return replayed
        }
        try {
            return await this.createOrder(dto, idempotency)
        } catch (error) {
            // Two requests with the same key raced past the lookup: the second one's
            // transaction (and its stock) was rolled back; answer with the first one's order.
            if (idempotency && isIdempotencyKeyConflict(error)) {
                const replayed = await this.replay(idempotency)
                if (replayed) return replayed
            }
            throw error
        }
    }

    /**
     * The answer for a retried checkout: null when no order holds the key (or it is older than
     * the window, and is then freed); 409 when the key came with another body.
     */
    private async replay(idempotency: CheckoutIdempotency): Promise<CreatedOrderDto | null> {
        const orders = this.dataSource.getRepository(Order)
        const existing = await orders.findOne({
            where: { idempotencyKey: idempotency.key },
            select: { id: true, code: true, createdAt: true, idempotencyHash: true },
        })
        if (!existing) return null
        if (Date.now() - existing.createdAt.getTime() >= IDEMPOTENCY_WINDOW_MS) {
            await orders.update(
                { id: existing.id, idempotencyKey: idempotency.key },
                { idempotencyKey: null, idempotencyHash: null },
            )
            return null
        }
        if (existing.idempotencyHash !== idempotency.hash) throw idempotencyKeyReused()

        const { token } = await this.access.issue(existing.id, existing.code, null)
        const full = await this.loadFull(existing.id)
        this.logger.log(`Order ${existing.code} returned again for a retried checkout`)
        return {
            code: existing.code,
            accessToken: token,
            order: toPublicOrder(full, await this.pagoMovil(), await this.catalog.labeler()),
            replayed: true,
        }
    }

    private async createOrder(
        dto: CreateOrderDto,
        idempotency: CheckoutIdempotency | null,
    ): Promise<CreatedOrderDto> {
        // The DTO checked the shape ("0424-1234567"); the operator code must be active.
        const phoneProblem = await this.mobilePrefixes.phoneProblem(dto.phone)
        if (phoneProblem) throw fieldError('phone', phoneProblem)

        const content = await this.content.getAll()
        if (!isPaymentConfigured(content.payment)) {
            throw new ServiceUnavailableException({
                statusCode: 503,
                error: 'Service Unavailable',
                code: PAYMENT_METHOD_UNAVAILABLE,
                message:
                    'Por ahora no podemos recibir pedidos en línea. Escríbenos por WhatsApp y te ayudamos.',
            })
        }
        const rate = await this.rates.requireUsableRate()
        const pending: PendingOrderEvent[] = []

        let token = ''
        const order = await this.dataSource.transaction(async (manager) => {
            const catalog = await this.lockCatalog(manager, dto.items)
            const lines = this.priceLines(dto.items, catalog)

            const totals = computeTotals(
                lines.map((line) => ({ unitCents: line.unitCents, quantity: line.quantity })),
                dto.deliveryMethod,
                content.shipping,
                rate.rate,
            )

            // Rows are locked, and the totals per variant were checked against the stock.
            await changeStock(
                manager,
                'take',
                lines.map((line) => ({
                    productId: line.product.id,
                    variantId: line.variant?.id ?? null,
                    quantity: line.quantity,
                })),
            )

            const [{ seq }] = (await manager.query(
                `SELECT nextval('order_code_seq')::int AS "seq"`,
            )) as [{ seq: number }]
            const now = new Date()
            const created: Order = manager.create(Order, {
                id: newId(),
                code: `KZ-${String(seq).padStart(6, '0')}`,
                status: 'PENDIENTE_PAGO',
                customerName: dto.fullName,
                customerEmail: dto.email.toLowerCase(),
                customerPhone: dto.phone,
                city: dto.city,
                address: dto.address,
                deliveryMethod: dto.deliveryMethod,
                notes: dto.notes ?? '',
                ...totals,
                exchangeRate: rate.rate,
                exchangeRateSource: rate.source,
                exchangeRateDate: rate.effectiveDate,
                exchangeRateId: rate.id,
                paymentDueAt: this.statuses.paymentDeadline(now),
                stockRestored: false,
                latePayment: false,
                stockConflict: null,
                refundStatus: null,
                refundReference: null,
                refundedAt: null,
                refundedById: null,
                idempotencyKey: idempotency?.key ?? null,
                idempotencyHash: idempotency?.hash ?? null,
                createdAt: now,
                updatedAt: now,
            })
            await manager.insert(Order, created)
            // The customer's first private link (only its hash is stored).
            token = (await this.access.issue(created.id, created.code, null, manager)).token

            created.items = lines.map((line, index) =>
                manager.create(OrderItem, {
                    id: newId(),
                    orderId: created.id,
                    productId: line.product.id,
                    variantId: line.variant?.id ?? null,
                    productName: line.product.name,
                    productSlug: line.product.slug,
                    variantLabel: line.variant?.label ?? null,
                    imageUrl: catalog.firstImage.get(line.product.id) ?? null,
                    unitPriceUsd: fromCents(line.unitCents),
                    quantity: line.quantity,
                    lineTotalUsd: fromCents(line.unitCents * line.quantity),
                    sortOrder: index,
                }),
            )
            await manager.insert(OrderItem, created.items)

            const entry = manager.create(OrderStatusHistory, {
                id: newId(),
                orderId: created.id,
                fromStatus: null,
                toStatus: 'PENDIENTE_PAGO',
                actorType: 'customer',
                actorUserId: null,
                note: null,
                createdAt: now,
            })
            await manager.insert(OrderStatusHistory, entry)
            created.history = [entry]
            created.payments = []

            pending.push({
                name: ORDER_EVENTS.created,
                payload: {
                    orderId: created.id,
                    code: created.code,
                    customerName: created.customerName,
                    customerPhone: created.customerPhone,
                    totalUsd: created.totalUsd,
                    totalBs: created.totalBs,
                    exchangeRate: created.exchangeRate,
                    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
                    paymentDueAt: created.paymentDueAt.toISOString(),
                    createdAt: now.toISOString(),
                },
            })
            // In the order's transaction: no "Pedido recibido" without the order, and vice versa.
            await this.statuses.recordEvents(manager, pending)
            return created
        })

        this.statuses.emit(pending)
        this.logger.log(`Order ${order.code} created (${order.totalUsd} USD)`)
        return {
            code: order.code,
            accessToken: token,
            order: toPublicOrder(order, content.payment, await this.catalog.labeler()),
            replayed: false,
        }
    }

    /** The customer's order page. A wrong or missing token is a plain 404. */
    async getForCustomer(code: string, token: string | undefined): Promise<PublicOrderDto> {
        const order = await this.findAuthorized(code, token)
        const full = await this.loadFull(order.id)
        return toPublicOrder(full, await this.pagoMovil(), await this.catalog.labeler())
    }

    async submitPayment(
        code: string,
        token: string | undefined,
        dto: SubmitPaymentDto,
        file: Express.Multer.File | undefined,
    ): Promise<PublicOrderDto> {
        const order = await this.findAuthorized(code, token)
        await this.recordPayment(order.code, dto, file, { kind: 'customer' })
        return this.getForCustomer(code, token)
    }

    /**
     * Records one Pago Móvil proof and moves the order to PENDIENTE_VERIFICACION. Used by the
     * customer's page and by an admin who got the proof by WhatsApp (`actor.kind === 'admin'`).
     * A real payment is never refused for being late: it is accepted, and flagged `late` when its
     * payment date is after the deadline's day; an expired order takes its stock back (what is
     * missing becomes a stock conflict for the admin to resolve).
     */
    async recordPayment(
        code: string,
        dto: SubmitPaymentDto,
        file: Express.Multer.File | undefined,
        actor: Extract<OrderActor, { kind: 'customer' | 'admin' }>,
    ): Promise<void> {
        const order = await this.dataSource.getRepository(Order).findOne({ where: { code } })
        if (!order) throw new NotFoundException(ORDER_NOT_FOUND)
        this.assertPayable(order)

        const today = caracasDay()
        const earliest = addDays(caracasDay(order.createdAt), -1)
        if (dto.paidOn > today) {
            throw fieldError('paidOn', 'La fecha del pago no puede estar en el futuro.')
        }
        if (dto.paidOn < earliest) {
            throw fieldError('paidOn', 'La fecha del pago es anterior a la creación del pedido.')
        }
        // Only active banks of the catalog; the name is kept as a snapshot on the payment.
        const bank = await this.banks.findActive(dto.payerBankCode)
        if (!bank) throw fieldError('payerBankCode', 'Elige el banco desde el que pagaste.')
        const phoneProblem = await this.mobilePrefixes.phoneProblem(dto.payerPhone)
        if (phoneProblem) throw fieldError('payerPhone', phoneProblem)
        const bankName = bank.name

        let proofKey: string | null = null
        if (file) {
            const type = detectImageType(file.buffer)
            if (!type) {
                throw fieldError('proof', 'La captura debe ser una imagen JPG, PNG o WEBP.')
            }
            try {
                proofKey = (
                    await this.storage.uploadPrivate(
                        { buffer: file.buffer, type },
                        'payment-proofs',
                    )
                ).key
            } catch (error) {
                this.logger.error(`Proof upload failed for ${order.code}`, error as Error)
                throw new BadRequestException(
                    'No pudimos guardar la captura. Intenta de nuevo o envía solo la referencia.',
                )
            }
        }

        const pending: PendingOrderEvent[] = []
        try {
            await this.dataSource.transaction(async (manager) => {
                const locked = await this.statuses.lockByCode(manager, order.code)
                if (!locked) throw new NotFoundException(ORDER_NOT_FOUND)
                this.assertPayable(locked)

                const duplicateIds = await this.findDuplicateReferences(
                    manager,
                    locked.id,
                    dto.reference,
                )
                if (duplicateIds.length) {
                    await manager.update(
                        OrderPayment,
                        { id: In(duplicateIds) },
                        { duplicateReference: true },
                    )
                }

                const now = new Date()
                const late = isLatePayment(locked, dto.paidOn)
                const payment = manager.create(OrderPayment, {
                    id: newId(),
                    orderId: locked.id,
                    status: 'PENDIENTE',
                    reference: dto.reference,
                    payerBankCode: dto.payerBankCode,
                    payerBankName: bankName,
                    payerPhone: dto.payerPhone,
                    payerIdNumber: dto.payerIdNumber ?? null,
                    paidOn: dto.paidOn,
                    amountBs: dto.amountBs,
                    expectedBs: locked.totalBs,
                    duplicateReference: duplicateIds.length > 0,
                    proofKey,
                    hasProof: proofKey !== null,
                    late,
                    source: actor.kind,
                    recordedById: actor.kind === 'admin' ? actor.userId : null,
                    rejectionReason: null,
                    reviewedAt: null,
                    reviewedById: null,
                    createdAt: now,
                })
                await manager.insert(OrderPayment, payment)
                if (late && !locked.latePayment) {
                    await manager.update(Order, { id: locked.id }, { latePayment: true })
                    locked.latePayment = true
                }

                const transitionEvents: PendingOrderEvent[] = []
                await this.statuses.applyTransition(
                    manager,
                    locked,
                    'PENDIENTE_VERIFICACION',
                    actor,
                    {
                        paymentRecorded: true,
                        note: [
                            actor.kind === 'admin'
                                ? 'Pago registrado por la administración (comprobante recibido por WhatsApp).'
                                : null,
                            late ? 'Pago hecho después del plazo, según la fecha indicada.' : null,
                        ]
                            .filter(Boolean)
                            .join(' '),
                    },
                    transitionEvents,
                )

                pending.push(
                    {
                        name: ORDER_EVENTS.paymentSubmitted,
                        payload: {
                            orderId: locked.id,
                            code: locked.code,
                            paymentId: payment.id,
                            reference: payment.reference,
                            payerBankCode: payment.payerBankCode,
                            payerBankName: payment.payerBankName,
                            amountBs: payment.amountBs,
                            expectedBs: payment.expectedBs,
                            amountDifferenceBs: amountDifferenceBs(
                                payment.amountBs,
                                payment.expectedBs,
                            ),
                            duplicateReference: payment.duplicateReference,
                            hasProof: payment.hasProof,
                            late,
                            source: payment.source,
                            stockConflict: Boolean(
                                locked.stockConflict && !locked.stockConflict.resolvedAt,
                            ),
                            submittedAt: payment.createdAt.toISOString(),
                        },
                    },
                    ...transitionEvents,
                )
                // In the payment's transaction: the owner hears of every recorded payment.
                await this.statuses.recordEvents(manager, pending)
            })
        } catch (error) {
            if (proofKey) {
                await this.storage.deletePrivate(proofKey).catch((cleanupError: unknown) => {
                    this.logger.warn(
                        `Could not delete orphan proof ${proofKey}: ${String(cleanupError)}`,
                    )
                })
            }
            throw error
        }

        this.statuses.emit(pending)
    }

    /** 404 unless the code exists and the token opens one of its links. */
    private findAuthorized(code: string, token: string | undefined): Promise<Order> {
        return this.access.findAuthorized(code, token)
    }

    private assertPayable(order: Order): void {
        if (canSubmitPayment(order)) return
        if (order.status === 'PENDIENTE_VERIFICACION') {
            throw new ConflictException(
                'Ya recibimos un pago para este pedido y lo estamos verificando.',
            )
        }
        if (order.status === 'CANCELADO') {
            throw new ConflictException(
                'Este pedido fue cancelado. Si hiciste un pago, escríbenos por WhatsApp.',
            )
        }
        throw new ConflictException('Este pedido ya no admite pagos.')
    }

    private async loadFull(orderId: string): Promise<Order> {
        const order = await this.dataSource.getRepository(Order).findOne({
            where: { id: orderId },
            relations: { items: true, payments: true, history: true },
        })
        if (!order) throw new NotFoundException(ORDER_NOT_FOUND)
        return order
    }

    private async pagoMovil(): Promise<PaymentContent | null> {
        const { payment } = await this.content.getAll()
        return isPaymentConfigured(payment) ? payment : null
    }

    /**
     * Other payments with this reference on orders that are still alive. References are the
     * last 6 digits; older payments stored the whole number, so they are compared by its end.
     * A match only flags the payments for the admin, it never refuses one.
     *
     * The digit count is inlined (not a bind parameter) so the expression is literally
     * `RIGHT("reference", 6)` and always matches the `order_payments_reference_tail_idx`
     * expression index, whatever plan Postgres picks.
     */
    private async findDuplicateReferences(
        manager: EntityManager,
        orderId: string,
        reference: string,
    ): Promise<string[]> {
        const rows = (await manager.query(
            `SELECT p."id" FROM "order_payments" p
             JOIN "orders" o ON o."id" = p."order_id"
             WHERE RIGHT(p."reference", ${REFERENCE_DIGITS}) = $1
               AND p."order_id" <> $2 AND o."status" <> ALL($3)`,
            [reference, orderId, CLOSED_STATUSES],
        )) as { id: string }[]
        return rows.map((row) => row.id)
    }

    /** Locks the ordered products and their variants (see `lockStock`) and reads photos. */
    private async lockCatalog(
        manager: EntityManager,
        items: readonly OrderItemInputDto[],
    ): Promise<LockedCatalog> {
        const ids = [...new Set(items.map((item) => item.productId))].sort()
        const locked = await lockStock(manager, ids)
        const images = await manager.find(ProductImage, {
            where: { productId: In(ids) },
            order: { sortOrder: 'ASC', createdAt: 'ASC' },
            select: { productId: true, url: true, sortOrder: true, createdAt: true, id: true },
        })

        const firstImage = new Map<string, string>()
        for (const image of images) {
            if (!firstImage.has(image.productId)) firstImage.set(image.productId, image.url)
        }
        return { ...locked, firstImage }
    }

    /**
     * Server-side prices for every line; throws 400 with one message per bad line. The stock
     * is checked per variant (or per product without variants), adding up every cart line of
     * that variant: earlier lines keep their units first, and each short line reports what it
     * can keep (`available`).
     */
    private priceLines(items: readonly OrderItemInputDto[], catalog: LockedCatalog) {
        const problems: OrderLineProblem[] = []
        /** Units still free per stock unit while walking the cart in order. */
        const remaining = new Map<string, number>()
        const lines = items.map((item, index) => {
            const product = catalog.products.get(item.productId)
            const problem = (message: string, available = 0) =>
                problems.push({
                    index,
                    productId: item.productId,
                    variantId: item.variantId ?? null,
                    available,
                    message,
                })

            if (!product || !product.isActive) {
                problem(
                    product
                        ? `«${product.name}» ya no está disponible.`
                        : 'Este producto ya no está disponible.',
                )
                return null
            }
            const variants = catalog.variants.get(product.id) ?? []
            const variant = item.variantId
                ? variants.find((candidate) => candidate.id === item.variantId)
                : undefined
            if (item.variantId && !variant) {
                problem(`La opción elegida de «${product.name}» ya no existe. Elígela de nuevo.`)
                return null
            }
            if (!item.variantId && variants.length > 0) {
                problem(`Elige una opción de «${product.name}».`)
                return null
            }

            const key = stockUnitKey(product.id, variant?.id ?? null)
            const stock = Math.max(0, variant ? variant.stock : product.stock)
            const left = remaining.get(key) ?? stock
            const keeps = Math.min(item.quantity, left)
            remaining.set(key, left - keeps)
            if (keeps < item.quantity) {
                problem(stockMessage(stockItemName(product.name, variant?.label), stock), keeps)
                return null
            }
            return {
                product,
                variant: variant ?? null,
                quantity: item.quantity,
                unitCents: unitPriceCents(product.price, variant?.priceDelta ?? 0),
            }
        })

        if (problems.length) throw lineProblemsError(problems)
        return lines.filter((line): line is NonNullable<typeof line> => line !== null)
    }
}
