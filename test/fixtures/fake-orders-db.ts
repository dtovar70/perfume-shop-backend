import { FindOperator, QueryFailedError } from 'typeorm'
import { User } from '../../src/auth/entities/user.entity.js'
import { Role } from '../../src/auth/role.enum.js'
import { Category } from '../../src/categories/entities/category.entity.js'
import { caracasDay } from '../../src/common/utils/caracas-date.js'
import { SiteContentEntry } from '../../src/content/entities/site-content.entity.js'
import { ExchangeRate } from '../../src/exchange-rate/entities/exchange-rate.entity.js'
import { OrderAccessLink } from '../../src/orders/entities/order-access-link.entity.js'
import { OrderItem } from '../../src/orders/entities/order-item.entity.js'
import { OrderNote } from '../../src/orders/entities/order-note.entity.js'
import { OrderPayment } from '../../src/orders/entities/order-payment.entity.js'
import { OrderStatusHistory } from '../../src/orders/entities/order-status-history.entity.js'
import { Order } from '../../src/orders/entities/order.entity.js'
import { ProductImage } from '../../src/products/entities/product-image.entity.js'
import { ProductVariant } from '../../src/products/entities/product-variant.entity.js'
import { Product } from '../../src/products/entities/product.entity.js'
import { catalogRepository } from './catalogs.js'

export type Row = Record<string, unknown>

export const USERS = {
    admin: { id: 'admin-1', role: Role.ADMIN, name: 'Dueña' },
    editor: { id: 'editor-1', role: Role.EDITOR, name: 'Editor' },
}

export const PAGO_MOVIL = {
    bankCode: '0134',
    bankName: 'Banesco',
    phone: '0412-5550134',
    idNumber: 'V-12345678',
    holderName: 'KaiZen C.A.',
    instructions: '',
}

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
        if (expected instanceof FindOperator) {
            const value = expected.value as unknown
            if (expected.type === 'in') return (value as unknown[]).includes(row[key])
            if (expected.type === 'lessThan') return (row[key] as Date) < (value as Date)
            if (expected.type === 'isNull') return row[key] === null || row[key] === undefined
            throw new Error(`Unsupported operator ${expected.type}`)
        }
        return row[key] === expected
    })
}

/**
 * Just enough of TypeORM, in memory, for the order flow: query builders by code/ids, finds,
 * inserts, updates and the few raw statements the services run (stock, sequence, duplicates).
 */
export class FakeDb {
    seq = 0
    /**
     * Opt-in: transactions run one at a time (like two checkouts waiting on the same row locks)
     * and an error rolls every table back, so a failed transaction leaves no writes behind.
     */
    isolatedTransactions = false
    private transactionQueue: Promise<unknown> = Promise.resolve()
    tables = new Map<unknown, Row[]>([
        [Category, []],
        [Product, []],
        [ProductVariant, []],
        [ProductImage, []],
        [Order, []],
        [OrderItem, []],
        [OrderPayment, []],
        [OrderStatusHistory, []],
        [OrderNote, []],
        [OrderAccessLink, []],
        [ExchangeRate, []],
        [SiteContentEntry, []],
    ])

    constructor() {
        const category = (slug: string) => ({
            slug,
            name: slug,
            tagline: '',
            description: '',
            colorHex: '#FFD979',
            sortOrder: 0,
        })
        this.table(Category).push(category('arabes'), category('europeos'), category('sets-regalo'))
        this.table(Product).push(
            {
                id: 'perfume-001',
                slug: 'lattafa-khamrah',
                name: 'Lattafa Khamrah',
                price: 12.9,
                stock: 8,
                isActive: true,
                categorySlug: 'arabes',
                tags: [],
            },
            {
                id: 'perfume-002',
                slug: 'khamrah',
                name: 'Khamrah',
                price: 20,
                stock: 1,
                isActive: true,
                categorySlug: 'europeos',
                tags: [],
            },
            {
                id: 'off-001',
                slug: 'oculto',
                name: 'Oculto',
                price: 5,
                stock: 9,
                isActive: false,
                categorySlug: 'arabes',
                tags: [],
            },
            // No variants: the product row holds its own stock.
            {
                id: 'perfume-003',
                slug: 'asad',
                name: 'Asad',
                price: 4,
                stock: 3,
                isActive: true,
                categorySlug: 'arabes',
                tags: [],
            },
        )
        // Stock per variant; `products.stock` is their sum (8 for Lattafa Khamrah, 1 for Khamrah).
        this.table(ProductVariant).push(
            {
                id: 'v-11oz',
                productId: 'perfume-001',
                label: '11 oz',
                priceDelta: 0,
                stock: 3,
                sortOrder: 0,
            },
            {
                id: 'v-15oz',
                productId: 'perfume-001',
                label: '15 oz',
                priceDelta: 3.1,
                stock: 5,
                sortOrder: 1,
            },
            {
                id: 'v-m',
                productId: 'perfume-002',
                label: 'M',
                priceDelta: 0,
                stock: 1,
                sortOrder: 0,
            },
        )
        this.table(ProductImage).push({
            id: 'img-1',
            productId: 'perfume-001',
            url: 'http://img/lattafa-khamrah.jpg',
            sortOrder: 0,
            createdAt: new Date(),
        })
        this.table(ExchangeRate).push({
            id: 'rate-1',
            rate: 854.4637,
            source: 'bcv',
            effectiveDate: caracasDay(),
            fetchedAt: new Date(),
            isManual: false,
            createdById: null,
            createdBy: null,
        })
        this.table(SiteContentEntry).push({ key: 'payment', value: PAGO_MOVIL })
    }

    table(entity: unknown): Row[] {
        const rows = this.tables.get(entity)
        if (!rows) throw new Error('Unknown entity')
        return rows
    }

    /** A product's stock (the sum of its variants when it has any). */
    stock(id: string): number {
        return this.table(Product).find((row) => row.id === id)?.stock as number
    }

    variantStock(id: string): number {
        return this.table(ProductVariant).find((row) => row.id === id)?.stock as number
    }

    /** Sets a variant's stock and keeps its product's total in sync, like the admin does. */
    setVariantStock(id: string, stock: number): void {
        const variant = this.table(ProductVariant).find((row) => row.id === id)!
        variant.stock = stock
        this.syncProductStock(variant.productId as string)
    }

    private syncProductStock(productId: string): void {
        const variants = this.table(ProductVariant).filter((row) => row.productId === productId)
        const product = this.table(Product).find((row) => row.id === productId)
        if (product && variants.length) {
            product.stock = variants.reduce((sum, row) => sum + (row.stock as number), 0)
        }
    }

    private queryBuilder(entity: unknown) {
        const params: Row = {}
        const builder = {
            setLock: () => builder,
            select: () => builder,
            addSelect: () => builder,
            groupBy: () => builder,
            orderBy: () => builder,
            addOrderBy: () => builder,
            skip: () => builder,
            take: () => builder,
            innerJoin: () => builder,
            where: (_sql: string, values: Row = {}) => (Object.assign(params, values), builder),
            andWhere: (_sql: string, values: Row = {}) => (Object.assign(params, values), builder),
            getMany: () =>
                Promise.resolve(
                    this.table(entity).filter((row) =>
                        params.productIds
                            ? (params.productIds as string[]).includes(row.productId as string)
                            : (params.ids as string[]).includes(row.id as string),
                    ),
                ),
            // The admin list: per-status counts, pending refunds and one filtered page.
            getRawMany: () => {
                if (entity === Product) {
                    // Product counts per category (CategoriesService.productCounts).
                    const counts = new Map<string, Row>()
                    for (const product of this.table(Product)) {
                        const slug = product.categorySlug as string
                        if (params.slug && params.slug !== slug) continue
                        const row = counts.get(slug) ?? { slug, active: 0, total: 0 }
                        row.total = (row.total as number) + 1
                        if (product.isActive) row.active = (row.active as number) + 1
                        counts.set(slug, row)
                    }
                    return Promise.resolve([...counts.values()])
                }
                if (entity === OrderItem) {
                    const quantities = new Map<string, number>()
                    for (const item of this.table(OrderItem)) {
                        const orderId = item.orderId as string
                        if (!(params.ids as string[]).includes(orderId)) continue
                        quantities.set(
                            orderId,
                            (quantities.get(orderId) ?? 0) + (item.quantity as number),
                        )
                    }
                    return Promise.resolve(
                        [...quantities].map(([orderId, quantity]) => ({ orderId, quantity })),
                    )
                }
                const counts = new Map<string, number>()
                for (const order of this.table(Order)) {
                    const status = order.status as string
                    counts.set(status, (counts.get(status) ?? 0) + 1)
                }
                return Promise.resolve([...counts].map(([status, count]) => ({ status, count })))
            },
            getCount: () =>
                Promise.resolve(
                    this.table(Order).filter(
                        (row) => !params.pendingRefund || row.refundStatus === params.pendingRefund,
                    ).length,
                ),
            getManyAndCount: () => {
                const rows = this.table(Order)
                    .filter(
                        (row) =>
                            (!params.statuses ||
                                (params.statuses as string[]).includes(row.status as string)) &&
                            (!params.refundStatus || row.refundStatus === params.refundStatus),
                    )
                    .reverse()
                return Promise.resolve([rows, rows.length])
            },
            getOne: () => {
                if (entity === Order) {
                    return Promise.resolve(
                        this.table(Order).find((row) => row.code === params.code) ?? null,
                    )
                }
                const payment = this.table(OrderPayment).find((row) => row.id === params.paymentId)
                const order = this.table(Order).find((row) => row.id === payment?.orderId)
                return Promise.resolve(order?.code === params.code ? payment : null)
            },
        }
        return builder
    }

    private withRelations(order: Row): Row {
        const of = (entity: unknown) => this.table(entity).filter((row) => row.orderId === order.id)
        return {
            ...order,
            items: of(OrderItem),
            payments: of(OrderPayment),
            history: of(OrderStatusHistory),
            adminNotes: of(OrderNote),
        }
    }

    private insert(entity: unknown, rows: Row | Row[]) {
        const now = new Date()
        for (const row of Array.isArray(rows) ? rows : [rows]) {
            // The unique index on orders.idempotency_key.
            if (
                entity === Order &&
                row.idempotencyKey &&
                this.table(Order).some((order) => order.idempotencyKey === row.idempotencyKey)
            ) {
                return Promise.reject(
                    new QueryFailedError('INSERT INTO "orders"', [], {
                        code: '23505',
                        constraint: 'orders_idempotency_key_key',
                    } as unknown as Error),
                )
            }
            this.table(entity).push({ createdAt: now, updatedAt: now, ...row })
        }
        return Promise.resolve({})
    }

    private update(entity: unknown, where: Row, changes: Row) {
        for (const row of this.table(entity).filter((candidate) => matches(candidate, where))) {
            Object.assign(row, changes, entity === Order ? { updatedAt: new Date() } : {})
        }
        return Promise.resolve({})
    }

    private rawQuery(sql: string, params: unknown[] = []): Promise<unknown> {
        if (sql.includes('nextval')) return Promise.resolve([{ seq: ++this.seq }])
        if (sql.includes('SUM(v."stock")')) {
            this.syncProductStock(params[0] as string)
            return Promise.resolve([])
        }
        if (sql.includes('"stock" - $1') || sql.includes('"stock" + $1')) {
            const entity = sql.includes('"product_variants"') ? ProductVariant : Product
            const row = this.table(entity).find((candidate) => candidate.id === params[1])
            const delta = (params[0] as number) * (sql.includes('"stock" - $1') ? -1 : 1)
            if (row && (row.stock as number) + delta >= 0) {
                row.stock = (row.stock as number) + delta
            }
            return Promise.resolve([])
        }
        if (sql.includes('FROM "order_payments" p')) {
            const [reference, orderId, closed, digits] = params as [
                string,
                string,
                string[],
                number,
            ]
            return Promise.resolve(
                this.table(OrderPayment).filter((payment) => {
                    const order = this.table(Order).find((row) => row.id === payment.orderId)
                    return (
                        (payment.reference as string).slice(-digits) === reference &&
                        payment.orderId !== orderId &&
                        !closed.includes(order?.status as string)
                    )
                }),
            )
        }
        throw new Error(`Unexpected SQL: ${sql}`)
    }

    readonly manager = {
        createQueryBuilder: (entity: unknown) => this.queryBuilder(entity),
        create: (_entity: unknown, value: Row) => ({ ...value }),
        insert: (entity: unknown, rows: Row | Row[]) => this.insert(entity, rows),
        update: (entity: unknown, where: Row, changes: Row) => this.update(entity, where, changes),
        query: (sql: string, params?: unknown[]) => this.rawQuery(sql, params),
        find: (entity: unknown, options: { where?: Row } = {}) =>
            Promise.resolve(this.table(entity).filter((row) => matches(row, options.where))),
    }

    repository(entity: unknown) {
        const catalog = catalogRepository(entity)
        if (catalog) return catalog
        if (entity === User) {
            return {
                findOneBy: ({ id }: { id: string }) => {
                    const user = Object.values(USERS).find((candidate) => candidate.id === id)
                    return Promise.resolve(
                        user
                            ? {
                                  ...user,
                                  email: `${user.id}@example.com`,
                                  isActive: true,
                                  passwordChangedAt: null,
                                  createdAt: new Date(),
                                  updatedAt: new Date(),
                              }
                            : null,
                    )
                },
            }
        }
        return {
            ...this.manager,
            find: (options: { where?: Row; take?: number } = {}) =>
                Promise.resolve(this.table(entity).filter((row) => matches(row, options.where))),
            findOne: (options: { where?: Row }) => {
                const found = this.table(entity).find((row) => matches(row, options.where))
                if (!found) return Promise.resolve(null)
                return Promise.resolve(entity === Order ? this.withRelations(found) : found)
            },
            findOneBy: (where: Row) =>
                Promise.resolve(this.table(entity).find((row) => matches(row, where)) ?? null),
            existsBy: (where: Row) =>
                Promise.resolve(this.table(entity).some((row) => matches(row, where))),
            insert: (rows: Row | Row[]) => this.insert(entity, rows),
            update: (where: Row, changes: Row) => this.update(entity, where, changes),
            delete: (where: Row) => {
                const rows = this.table(entity)
                const keep = rows.filter((row) => !matches(row, where))
                const affected = rows.length - keep.length
                rows.splice(0, rows.length, ...keep)
                return Promise.resolve({ affected })
            },
            createQueryBuilder: () => this.queryBuilder(entity),
        }
    }

    readonly dataSource = {
        isInitialized: false,
        entityMetadatas: [],
        options: { type: 'postgres' },
        manager: this.manager,
        getRepository: (entity: unknown) => this.repository(entity),
        transaction: <T>(work: (manager: FakeDb['manager']) => Promise<T>): Promise<T> =>
            this.isolatedTransactions ? this.isolated(work) : work(this.manager),
    }

    private isolated<T>(work: (manager: FakeDb['manager']) => Promise<T>): Promise<T> {
        const run = async () => {
            const snapshot = new Map(
                [...this.tables].map(([entity, rows]) => [entity, rows.map((row) => ({ ...row }))]),
            )
            try {
                return await work(this.manager)
            } catch (error) {
                for (const [entity, rows] of snapshot) {
                    const table = this.table(entity)
                    table.splice(0, table.length, ...rows)
                }
                // Like Postgres, the order code sequence is not rolled back.
                throw error
            }
        }
        const result = this.transactionQueue.then(run, run)
        this.transactionQueue = result.catch(() => undefined)
        return result
    }
}
