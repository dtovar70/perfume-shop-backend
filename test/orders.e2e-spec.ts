import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { caracasDay } from '../src/common/utils/caracas-date.js'
import { DEFAULT_SITE_CONTENT } from '../src/content/content.defaults.js'
import { SiteContentEntry } from '../src/content/entities/site-content.entity.js'
import { ExchangeRate } from '../src/exchange-rate/entities/exchange-rate.entity.js'
import { OrderPayment } from '../src/orders/entities/order-payment.entity.js'
import { OrderAccessLink } from '../src/orders/entities/order-access-link.entity.js'
import { Order } from '../src/orders/entities/order.entity.js'
import { OrderExpiryService } from '../src/orders/order-expiry.service.js'
import { ORDER_EVENTS } from '../src/orders/orders.events.js'
import { ProductVariant } from '../src/products/entities/product-variant.entity.js'
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.service.js'

import { FakeDb, PAGO_MOVIL, PNG, USERS, type Row } from './fixtures/fake-orders-db.js'

describe('Orders (e2e)', () => {
    let app: INestApplication
    let db: FakeDb
    let cookie: (user: keyof typeof USERS) => string
    let events: { name: string; payload: Row }[]
    const storage = {
        driver: 'local' as const,
        upload: vi.fn(),
        delete: vi.fn(),
        uploadPrivate: vi.fn().mockResolvedValue({ key: 'payment-proofs/proof.png' }),
        readPrivate: vi.fn(),
        deletePrivate: vi.fn().mockResolvedValue(undefined),
    }

    const checkout = (overrides: Row = {}) => ({
        fullName: 'Ana Pérez',
        email: 'ana@example.com',
        phone: '0414-1234567',
        city: 'Caracas',
        address: 'Av. Principal, casa 4',
        notes: '',
        deliveryMethod: 'delivery',
        items: [{ productId: 'mug-001', variantId: 'v-15oz', quantity: 2 }],
        ...overrides,
    })

    const payment = (code: string, token: string, fields: Row = {}) => {
        const req = request(app.getHttpServer()).post(`/api/orders/${code}/payment?t=${token}`)
        const values: Row = {
            reference: '123456',
            payerBankCode: '0102',
            payerPhone: '0414-1234567',
            paidOn: caracasDay(),
            amountBs: '',
            ...fields,
        }
        for (const [key, value] of Object.entries(values)) req.field(key, String(value))
        return req
    }

    beforeEach(async () => {
        db = new FakeDb()
        events = []
        vi.clearAllMocks()
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(db.dataSource)
            .overrideProvider(STORAGE_SERVICE)
            .useValue(storage as unknown as StorageService)
            .compile()

        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.use(cookieParser())
        app.useGlobalPipes(createValidationPipe())
        await app.init()

        app.get(EventEmitter2).onAny((name, payload) => {
            events.push({ name: String(name), payload: payload as Row })
        })
        const signer = new JwtService({ secret: app.get(ConfigService).get<string>('JWT_SECRET') })
        cookie = (user) =>
            `kz_session=${signer.sign({ sub: USERS[user].id, role: USERS[user].role }, { expiresIn: 600 })}`
    })

    afterEach(async () => {
        await app.close()
    })

    it('prices the order on the server, decrements stock and returns a private link', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/orders')
            .send(checkout())
            .expect(201)

        const { code, accessToken, order } = response.body as {
            code: string
            accessToken: string
            order: Row & { totals: Row; items: Row[] }
        }
        expect(code).toBe('KZ-000001')
        expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
        // (12.90 + 3.10) x 2 = 32.00 < 35 -> + 4.00 shipping.
        expect(order.totals).toMatchObject({
            subtotalUsd: 32,
            shippingUsd: 4,
            totalUsd: 36,
            totalBs: 30760.69,
            exchangeRate: 854.4637,
        })
        expect(order.items[0]).toMatchObject({
            productName: 'Lattafa Khamrah',
            variantLabel: '15 oz',
            unitPriceUsd: 16,
            quantity: 2,
            imageUrl: 'http://img/taza.jpg',
        })
        expect(order.status).toBe('PENDIENTE_PAGO')
        expect(order.pagoMovil).toEqual(PAGO_MOVIL)
        // Only the ordered variant loses units; the product total follows.
        expect(db.variantStock('v-15oz')).toBe(3)
        expect(db.variantStock('v-11oz')).toBe(3)
        expect(db.stock('mug-001')).toBe(6)
        // Only the hash is stored.
        expect(db.table(OrderAccessLink)).toHaveLength(1)
        expect(db.table(OrderAccessLink)[0]).toMatchObject({
            orderId: db.table(Order)[0]?.id,
            createdById: null,
        })
        expect(db.table(OrderAccessLink)[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/)
        expect(db.table(OrderAccessLink)[0]?.tokenHash).not.toBe(accessToken)
        expect(events.map((event) => event.name)).toEqual([ORDER_EVENTS.created])

        await request(app.getHttpServer())
            .get(`/api/orders/${code}?t=${accessToken}`)
            .expect(200)
            .expect((res) => expect(res.body.code).toBe(code))
    })

    it('rejects client-side prices and reports stock problems per line', async () => {
        const forged = await request(app.getHttpServer())
            .post('/api/orders')
            .send(
                checkout({
                    items: [
                        { productId: 'mug-001', variantId: 'v-11oz', quantity: 1, unitPrice: 0.01 },
                    ],
                }),
            )
            .expect(400)
        expect(forged.body.details).toEqual([
            { field: 'items.0.unitPrice', errors: ['El campo "unitPrice" no está permitido.'] },
        ])

        const stock = await request(app.getHttpServer())
            .post('/api/orders')
            .send(
                checkout({
                    items: [
                        { productId: 'tee-001', variantId: 'v-m', quantity: 2 },
                        { productId: 'off-001', quantity: 1 },
                    ],
                }),
            )
            .expect(400)
        expect(stock.body.code).toBe('ORDER_ITEMS_INVALID')
        expect(stock.body.details).toEqual([
            { field: 'items.0', errors: ['Solo queda 1 unidad de «Khamrah – M».'] },
            { field: 'items.1', errors: ['«Oculto» ya no está disponible.'] },
        ])
        expect(stock.body.lines[0]).toMatchObject({ index: 0, available: 1 })
        expect(db.stock('tee-001')).toBe(1)
        expect(db.table(Order)).toHaveLength(0)
    })

    it('refuses orders without Pago Móvil details or a usable BCV rate', async () => {
        db.table(SiteContentEntry).length = 0
        const noPayment = await request(app.getHttpServer())
            .post('/api/orders')
            .send(checkout())
            .expect(503)
        expect(noPayment.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE')

        db.table(SiteContentEntry).push({ key: 'payment', value: PAGO_MOVIL })
        db.table(ExchangeRate)[0]!.effectiveDate = '2020-01-01'
        const stale = await request(app.getHttpServer())
            .post('/api/orders')
            .send(checkout())
            .expect(503)
        expect(stale.body).toMatchObject({
            code: 'EXCHANGE_RATE_UNAVAILABLE',
            message:
                'No pudimos obtener la tasa del BCV. Intenta más tarde o contáctanos por WhatsApp.',
        })
        const current = await request(app.getHttpServer())
            .get('/api/exchange-rate/current')
            .expect(200)
        expect(current.body).toMatchObject({ available: false, reason: 'stale' })
    })

    it('hides orders behind the token: wrong or missing token is a 404', async () => {
        const { body } = await request(app.getHttpServer())
            .post('/api/orders')
            .send(checkout())
            .expect(201)
        await request(app.getHttpServer()).get(`/api/orders/${body.code}`).expect(404)
        await request(app.getHttpServer())
            .get(`/api/orders/${body.code}?t=${'x'.repeat(43)}`)
            .expect(404)
        await request(app.getHttpServer())
            .get(`/api/orders/KZ-999999?t=${body.accessToken}`)
            .expect(404)
    })

    it('runs the payment flow: proof, flags, verification, fulfilment and a 409', async () => {
        const first = (
            await request(app.getHttpServer()).post('/api/orders').send(checkout()).expect(201)
        ).body
        const second = (
            await request(app.getHttpServer()).post('/api/orders').send(checkout()).expect(201)
        ).body

        const submitted = await payment(first.code, first.accessToken, { amountBs: '30.760,69' })
            .attach('proof', PNG, { filename: 'pago.png', contentType: 'image/png' })
            .expect(200)
        expect(submitted.body.status).toBe('PENDIENTE_VERIFICACION')
        expect(storage.uploadPrivate).toHaveBeenCalledTimes(1)

        // Stored before the 6-digit rule: the whole bank reference. Its last 6 digits count.
        const stored = db.table(OrderPayment)[0]
        if (stored) stored.reference = '0098123456'

        // Same reference on another order, different amount: accepted but flagged.
        await payment(second.code, second.accessToken, { amountBs: '30000' }).expect(200)
        await payment(second.code, second.accessToken, { amountBs: '30000' }).expect(409)

        const detail = await request(app.getHttpServer())
            .get(`/api/admin/orders/${second.code}`)
            .set('Cookie', cookie('editor'))
            .expect(200)
        expect(detail.body.payments[0]).toMatchObject({
            duplicateReference: true,
            amountMismatch: true,
            amountDifferenceBs: -760.69,
            proofPath: null,
        })
        expect(detail.body.allowedTransitions.map((rule: Row) => rule.to)).toEqual([
            'PAGO_VERIFICADO',
            'PAGO_RECHAZADO',
        ])
        expect(db.table(OrderPayment)[0]?.duplicateReference).toBe(true)

        const transition = (code: string, to: string, user: keyof typeof USERS, note?: string) =>
            request(app.getHttpServer())
                .post(`/api/admin/orders/${code}/transitions`)
                .set('Cookie', cookie(user))
                .send(note ? { to, note } : { to })

        await transition(first.code, 'ENVIADO', 'editor').expect(409)
        await transition(first.code, 'PAGO_VERIFICADO', 'editor').expect(200)
        for (const to of ['EN_PRODUCCION', 'LISTO_PARA_ENTREGA', 'ENVIADO', 'ENTREGADO']) {
            await transition(
                first.code,
                to,
                'editor',
                to === 'ENVIADO' ? 'MRW 123' : undefined,
            ).expect(200)
        }
        const conflict = await transition(first.code, 'EN_PRODUCCION', 'admin').expect(409)
        expect(conflict.body.message).toBe(
            'No se puede pasar un pedido de «Entregado» a «En producción».',
        )

        const publicView = await request(app.getHttpServer())
            .get(`/api/orders/${first.code}?t=${first.accessToken}`)
            .expect(200)
        expect(publicView.body.status).toBe('ENTREGADO')
        expect(publicView.body.history.find((entry: Row) => entry.status === 'ENVIADO').note).toBe(
            'MRW 123',
        )
        expect(publicView.body.payments[0].status).toBe('VERIFICADO')

        const changes = events.filter((event) => event.name === ORDER_EVENTS.statusChanged)
        expect(changes.at(-1)?.payload).toMatchObject({
            from: 'ENVIADO',
            to: 'ENTREGADO',
            actor: 'admin',
        })
        expect(events.filter((event) => event.name === ORDER_EVENTS.paymentSubmitted)).toHaveLength(
            2,
        )
    })

    it('rejects with a reason, lets the customer re-submit, and only ADMIN cancels (restoring stock)', async () => {
        const order = (
            await request(app.getHttpServer()).post('/api/orders').send(checkout()).expect(201)
        ).body
        await payment(order.code, order.accessToken, { amountBs: '30760.69' }).expect(200)

        const post = (path: string, user: keyof typeof USERS, body: Row) =>
            request(app.getHttpServer())
                .post(`/api/admin/orders/${order.code}${path}`)
                .set('Cookie', cookie(user))
                .send(body)

        await post('/transitions', 'editor', { to: 'PAGO_RECHAZADO' }).expect(400)
        await post('/transitions', 'editor', {
            to: 'PAGO_RECHAZADO',
            note: 'No llegó el pago',
        }).expect(200)

        const rejected = await request(app.getHttpServer()).get(
            `/api/orders/${order.code}?t=${order.accessToken}`,
        )
        expect(rejected.body).toMatchObject({ status: 'PAGO_RECHAZADO', canSubmitPayment: true })
        expect(rejected.body.payments[0]).toMatchObject({
            status: 'RECHAZADO',
            rejectionReason: 'No llegó el pago',
        })

        await payment(order.code, order.accessToken, {
            reference: '887766',
            amountBs: '30760.69',
        }).expect(200)

        await post('/transitions', 'editor', { to: 'CANCELADO', note: 'Cliente desistió' }).expect(
            403,
        )
        expect(db.variantStock('v-15oz')).toBe(3)
        // A payment is waiting: the admin must say whether money has to be given back.
        const noRefundAnswer = await post('/transitions', 'admin', {
            to: 'CANCELADO',
            note: 'Cliente desistió',
        }).expect(400)
        expect(noRefundAnswer.body.details).toEqual([
            { field: 'refundStatus', errors: ['Indica si hay que devolver dinero al cliente.'] },
        ])
        expect(db.variantStock('v-15oz')).toBe(3)
        const cancelled = await post('/transitions', 'admin', {
            to: 'CANCELADO',
            note: 'Cliente desistió',
            refundStatus: 'PENDIENTE',
        }).expect(200)
        expect(cancelled.body.status).toBe('CANCELADO')
        expect(cancelled.body.stockRestored).toBe(true)
        expect(cancelled.body.refund).toMatchObject({ status: 'PENDIENTE', refundedAt: null })
        expect(db.variantStock('v-15oz')).toBe(5)

        const refunded = await post('/refund', 'editor', { reference: '11223344' }).expect(200)
        expect(refunded.body.refund).toMatchObject({
            status: 'REEMBOLSADO',
            reference: '11223344',
        })
        expect(refunded.body.notes[0].body).toBe('Reembolsado (referencia 11223344).')
        await post('/refund', 'editor', {}).expect(409)
        expect(
            events
                .filter((event) => event.name === ORDER_EVENTS.refundUpdated)
                .map((e) => e.payload.refundStatus),
        ).toEqual(['PENDIENTE', 'REEMBOLSADO'])

        // The customer can no longer pay a cancelled order.
        const closed = await payment(order.code, order.accessToken, {
            reference: '443322',
            amountBs: '30760.69',
        }).expect(409)
        expect(closed.body.message).toBe(
            'Este pedido fue cancelado. Si hiciste un pago, escríbenos por WhatsApp.',
        )

        const noted = await post('/notes', 'editor', { body: 'Llamar mañana' }).expect(200)
        expect(noted.body.notes[0]).toMatchObject({ body: 'Llamar mañana' })
    })

    const createOrder = async (items?: Row[]) =>
        (
            await request(app.getHttpServer())
                .post('/api/orders')
                .send(items ? checkout({ items }) : checkout())
                .expect(201)
        ).body as { code: string; accessToken: string }

    const orderRow = (code: string) => db.table(Order).find((row) => row.code === code) as Row

    /** Deadline two days ago, so a payment dated today is after the deadline's day. */
    const overdue = (code: string) => {
        orderRow(code).paymentDueAt = new Date(Date.now() - 2 * 86_400_000)
    }

    const expire = async (code: string) => {
        overdue(code)
        await app.get(OrderExpiryService).expireOverdue()
        expect(orderRow(code).status).toBe('EXPIRADO')
    }

    const admin = (code: string, path: string, user: keyof typeof USERS, body: Row) =>
        request(app.getHttpServer())
            .post(`/api/admin/orders/${code}${path}`)
            .set('Cookie', cookie(user))
            .send(body)

    it('does not flag a payment made on time whose proof is uploaded after the deadline', async () => {
        const order = await createOrder()
        orderRow(order.code).paymentDueAt = new Date(Date.now() - 60_000)

        await payment(order.code, order.accessToken, {
            amountBs: '30760.69',
            paidOn: caracasDay(orderRow(order.code).paymentDueAt as Date),
        }).expect(200)
        expect(orderRow(order.code)).toMatchObject({
            status: 'PENDIENTE_VERIFICACION',
            latePayment: false,
        })
    })

    it('flags a payment dated after the deadline as late', async () => {
        const order = await createOrder()
        overdue(order.code)
        const page = await request(app.getHttpServer())
            .get(`/api/orders/${order.code}?t=${order.accessToken}`)
            .expect(200)
        expect(page.body.canSubmitPayment).toBe(true)

        await payment(order.code, order.accessToken, { amountBs: '30760.69' }).expect(200)
        const detail = await request(app.getHttpServer())
            .get(`/api/admin/orders/${order.code}`)
            .set('Cookie', cookie('editor'))
            .expect(200)
        expect(detail.body).toMatchObject({
            status: 'PENDIENTE_VERIFICACION',
            latePayment: true,
            stockConflict: null,
        })
        expect(detail.body.payments[0]).toMatchObject({ late: true, source: 'customer' })
        expect(detail.body.history.at(-1).note).toBe(
            'Pago hecho después del plazo, según la fecha indicada.',
        )
        const submitted = events.find((event) => event.name === ORDER_EVENTS.paymentSubmitted)
        expect(submitted?.payload).toMatchObject({
            late: true,
            source: 'customer',
            stockConflict: false,
        })
    })

    it('takes the stock back when an expired order receives its payment', async () => {
        const order = await createOrder()
        expect(db.variantStock('v-15oz')).toBe(3)
        await expire(order.code)
        expect(db.variantStock('v-15oz')).toBe(5)

        const paid = await payment(order.code, order.accessToken, { amountBs: '30760.69' }).expect(
            200,
        )
        expect(paid.body.status).toBe('PENDIENTE_VERIFICACION')
        expect(db.variantStock('v-15oz')).toBe(3)
        expect(orderRow(order.code)).toMatchObject({
            latePayment: true,
            stockRestored: false,
            stockConflict: null,
        })
    })

    it('accepts a late payment without stock, flags the conflict and needs an acknowledgement', async () => {
        const order = await createOrder([{ productId: 'tee-001', variantId: 'v-m', quantity: 1 }])
        await expire(order.code)
        // Sold elsewhere in the meantime.
        db.setVariantStock('v-m', 0)

        await payment(order.code, order.accessToken, { amountBs: '1' }).expect(200)
        expect(db.stock('tee-001')).toBe(0)
        const detail = await request(app.getHttpServer())
            .get(`/api/admin/orders/${order.code}`)
            .set('Cookie', cookie('editor'))
            .expect(200)
        expect(detail.body.status).toBe('PENDIENTE_VERIFICACION')
        expect(detail.body.stockConflict).toMatchObject({
            resolvedAt: null,
            lines: [
                {
                    productId: 'tee-001',
                    variantId: 'v-m',
                    productName: 'Khamrah',
                    variantLabel: 'M',
                    requested: 1,
                    available: 0,
                    reserved: 0,
                },
            ],
        })
        expect(detail.body.history.at(-1).note).toBe(
            'Pago hecho después del plazo, según la fecha indicada. Stock insuficiente: «Khamrah – M» pidió 1, hay 0.',
        )

        const unacknowledged = await admin(order.code, '/transitions', 'editor', {
            to: 'PAGO_VERIFICADO',
        }).expect(400)
        expect(unacknowledged.body.code).toBe('STOCK_CONFLICT_UNACKNOWLEDGED')
        expect(unacknowledged.body.details[0].field).toBe('acknowledgeStockConflict')
        expect(orderRow(order.code).status).toBe('PENDIENTE_VERIFICACION')

        const confirmed = await admin(order.code, '/transitions', 'editor', {
            to: 'PAGO_VERIFICADO',
            acknowledgeStockConflict: true,
        }).expect(200)
        expect(confirmed.body.status).toBe('PAGO_VERIFICADO')
        expect(confirmed.body.stockConflict.resolvedAt).not.toBeNull()
        expect(confirmed.body.history.at(-1).note).toBe(
            'Pago confirmado con stock insuficiente: «Khamrah – M» faltan 1 unidad.',
        )
        expect(db.stock('tee-001')).toBe(0)

        // Cancelling gives back only what the order really took (nothing here).
        await admin(order.code, '/transitions', 'admin', {
            to: 'CANCELADO',
            note: 'Sin franelas',
            refundStatus: 'NO_APLICA',
        }).expect(200)
        expect(db.stock('tee-001')).toBe(0)
    })

    it('lets staff record a payment sent by WhatsApp', async () => {
        const order = await createOrder()
        await admin(order.code, '/transitions', 'editor', { to: 'PENDIENTE_VERIFICACION' }).expect(
            409,
        )
        const req = request(app.getHttpServer())
            .post(`/api/admin/orders/${order.code}/payments`)
            .set('Cookie', cookie('editor'))
        for (const [key, value] of Object.entries({
            reference: '889900',
            payerBankCode: '0134',
            payerPhone: '0414-1234567',
            paidOn: caracasDay(),
            amountBs: '30760,69',
        })) {
            req.field(key, value)
        }
        const recorded = await req
            .attach('proof', PNG, { filename: 'pago.png', contentType: 'image/png' })
            .expect(200)
        expect(recorded.body.status).toBe('PENDIENTE_VERIFICACION')
        expect(recorded.body.payments[0]).toMatchObject({
            source: 'admin',
            late: false,
            reference: '889900',
        })
        expect(db.table(OrderPayment)[0]).toMatchObject({
            source: 'admin',
            recordedById: 'editor-1',
        })
        expect(recorded.body.history.at(-1)).toMatchObject({
            actor: 'admin',
            note: 'Pago registrado por la administración (comprobante recibido por WhatsApp).',
        })
        await request(app.getHttpServer())
            .post(`/api/admin/orders/${order.code}/payments`)
            .expect(401)
    })

    it('reactivates an expired order, refusing (or forcing) when stock is missing', async () => {
        const order = await createOrder([{ productId: 'tee-001', variantId: 'v-m', quantity: 1 }])
        await expire(order.code)
        db.setVariantStock('v-m', 0)

        const refused = await admin(order.code, '/transitions', 'editor', {
            to: 'PENDIENTE_PAGO',
        }).expect(409)
        expect(refused.body).toMatchObject({
            code: 'STOCK_INSUFFICIENT',
            message:
                'No hay stock suficiente para reactivar el pedido: «Khamrah – M» pidió 1, hay 0.',
        })
        expect(orderRow(order.code).status).toBe('EXPIRADO')

        const forced = await admin(order.code, '/transitions', 'editor', {
            to: 'PENDIENTE_PAGO',
            forceStock: true,
        }).expect(200)
        expect(forced.body.status).toBe('PENDIENTE_PAGO')
        expect(new Date(forced.body.paymentDueAt).getTime()).toBeGreaterThan(Date.now())
        expect(forced.body.stockConflict.lines[0]).toMatchObject({ requested: 1, available: 0 })
        expect(forced.body.history.at(-1).note).toBe(
            'Pedido reactivado con un nuevo plazo de pago. Stock insuficiente: «Khamrah – M» pidió 1, hay 0.',
        )
        expect(db.stock('tee-001')).toBe(0)

        const withStock = await createOrder()
        await expire(withStock.code)
        const reactivated = await admin(withStock.code, '/transitions', 'admin', {
            to: 'PENDIENTE_PAGO',
        }).expect(200)
        expect(reactivated.body).toMatchObject({ status: 'PENDIENTE_PAGO', stockConflict: null })
        expect(db.variantStock('v-15oz')).toBe(3)
    })

    describe('stock per variant', () => {
        const MUG = 'Lattafa Khamrah'

        it('adds up the lines of one variant and names it when it is short', async () => {
            const short = await request(app.getHttpServer())
                .post('/api/orders')
                .send(
                    checkout({
                        items: [
                            { productId: 'mug-001', variantId: 'v-15oz', quantity: 3 },
                            { productId: 'mug-001', variantId: 'v-11oz', quantity: 3 },
                            { productId: 'mug-001', variantId: 'v-15oz', quantity: 3 },
                        ],
                    }),
                )
                .expect(400)
            // 5 units of 15 oz: the first line keeps 3, the third can keep 2; 11 oz is fine.
            expect(short.body.details).toEqual([
                { field: 'items.2', errors: [`Solo quedan 5 unidades de «${MUG} – 15 oz».`] },
            ])
            expect(short.body.lines).toEqual([
                expect.objectContaining({ index: 2, variantId: 'v-15oz', available: 2 }),
            ])
            expect(db.variantStock('v-15oz')).toBe(5)

            await createOrder([
                { productId: 'mug-001', variantId: 'v-15oz', quantity: 2 },
                { productId: 'mug-001', variantId: 'v-11oz', quantity: 1 },
                { productId: 'mug-001', variantId: 'v-15oz', quantity: 2 },
            ])
            expect(db.variantStock('v-15oz')).toBe(1)
            expect(db.variantStock('v-11oz')).toBe(2)
            expect(db.stock('mug-001')).toBe(3)
        })

        it('refuses a sold-out variant while the other one still sells', async () => {
            db.setVariantStock('v-15oz', 0)
            expect(db.stock('mug-001')).toBe(3)

            const soldOut = await request(app.getHttpServer())
                .post('/api/orders')
                .send(checkout())
                .expect(400)
            expect(soldOut.body.details).toEqual([
                { field: 'items.0', errors: [`«${MUG} – 15 oz» se agotó.`] },
            ])
            expect(soldOut.body.lines[0]).toMatchObject({ index: 0, available: 0 })

            await createOrder([{ productId: 'mug-001', variantId: 'v-11oz', quantity: 3 }])
            expect(db.variantStock('v-11oz')).toBe(0)
            expect(db.stock('mug-001')).toBe(0)
        })

        it('gives each variant back its own units when the order expires', async () => {
            const order = await createOrder([
                { productId: 'mug-001', variantId: 'v-11oz', quantity: 1 },
                { productId: 'mug-001', variantId: 'v-15oz', quantity: 2 },
            ])
            expect([db.variantStock('v-11oz'), db.variantStock('v-15oz')]).toEqual([2, 3])
            await expire(order.code)
            expect([db.variantStock('v-11oz'), db.variantStock('v-15oz')]).toEqual([3, 5])
            expect(db.stock('mug-001')).toBe(8)
        })

        it('keeps the stock of a product without variants on the product', async () => {
            const order = await createOrder([{ productId: 'key-001', quantity: 2 }])
            expect(db.stock('key-001')).toBe(1)

            const short = await request(app.getHttpServer())
                .post('/api/orders')
                .send(checkout({ items: [{ productId: 'key-001', quantity: 2 }] }))
                .expect(400)
            expect(short.body.details).toEqual([
                { field: 'items.0', errors: ['Solo queda 1 unidad de «Asad».'] },
            ])

            await admin(order.code, '/transitions', 'admin', {
                to: 'CANCELADO',
                note: 'Duplicado',
            }).expect(200)
            expect(db.stock('key-001')).toBe(3)
        })

        it('restores nothing for a deleted variant and flags it when taken again', async () => {
            const order = await createOrder([
                { productId: 'mug-001', variantId: 'v-15oz', quantity: 2 },
                { productId: 'mug-001', variantId: 'v-11oz', quantity: 1 },
            ])
            // The owner removed the 15 oz version (its 3 remaining units go with it).
            const variants = db.table(ProductVariant)
            variants.splice(
                variants.findIndex((row) => row.id === 'v-15oz'),
                1,
            )

            await admin(order.code, '/transitions', 'admin', {
                to: 'CANCELADO',
                note: 'Duplicado',
            }).expect(200)
            expect(orderRow(order.code).stockRestored).toBe(true)
            expect(db.variantStock('v-11oz')).toBe(3)

            const refused = await admin(order.code, '/transitions', 'admin', {
                to: 'PENDIENTE_PAGO',
            }).expect(409)
            expect(refused.body.message).toBe(
                `No hay stock suficiente para reactivar el pedido: «${MUG} – 15 oz» pidió 2, hay 0.`,
            )

            const forced = await admin(order.code, '/transitions', 'admin', {
                to: 'PENDIENTE_PAGO',
                forceStock: true,
            }).expect(200)
            expect(forced.body.stockConflict.lines).toEqual([
                {
                    productId: 'mug-001',
                    variantId: 'v-15oz',
                    productName: MUG,
                    variantLabel: '15 oz',
                    requested: 2,
                    available: 0,
                    reserved: 0,
                    stillShort: true,
                },
            ])
            // The variant that still exists was taken again.
            expect(db.variantStock('v-11oz')).toBe(2)
        })

        it('takes a conflict line from its variant once the owner restocks it', async () => {
            const order = await createOrder([
                { productId: 'tee-001', variantId: 'v-m', quantity: 1 },
            ])
            await expire(order.code)
            db.setVariantStock('v-m', 0)
            await payment(order.code, order.accessToken, { amountBs: '1' }).expect(200)

            db.setVariantStock('v-m', 4)
            const confirmed = await admin(order.code, '/transitions', 'editor', {
                to: 'PAGO_VERIFICADO',
                acknowledgeStockConflict: true,
            }).expect(200)
            expect(confirmed.body.stockConflict.lines[0]).toMatchObject({
                variantId: 'v-m',
                reserved: 1,
            })
            expect(db.variantStock('v-m')).toBe(3)
            expect(db.stock('tee-001')).toBe(3)

            // Cancelling after the conflict gives back only what was taken.
            await admin(order.code, '/transitions', 'admin', {
                to: 'CANCELADO',
                note: 'Sin franelas',
                refundStatus: 'NO_APLICA',
            }).expect(200)
            expect(db.variantStock('v-m')).toBe(4)
        })

        it('confirms without acknowledgement once the owner restocked the variant', async () => {
            const order = await createOrder([
                { productId: 'tee-001', variantId: 'v-m', quantity: 1 },
            ])
            await expire(order.code)
            db.setVariantStock('v-m', 0)
            await payment(order.code, order.accessToken, { amountBs: '1' }).expect(200)

            db.setVariantStock('v-m', 2)
            const detail = await request(app.getHttpServer())
                .get(`/api/admin/orders/${order.code}`)
                .set('Cookie', cookie('editor'))
                .expect(200)
            expect(detail.body.stockConflict).toMatchObject({
                resolvedAt: null,
                stillShort: false,
                lines: [{ variantId: 'v-m', requested: 1, reserved: 0, available: 2 }],
            })
            const list = await request(app.getHttpServer())
                .get('/api/admin/orders')
                .set('Cookie', cookie('editor'))
                .expect(200)
            const row = (list.body.items as Row[]).find((item) => item.code === order.code)
            expect(row?.stockConflict).toBe(false)

            const confirmed = await admin(order.code, '/transitions', 'editor', {
                to: 'PAGO_VERIFICADO',
            }).expect(200)
            expect(confirmed.body.status).toBe('PAGO_VERIFICADO')
            expect(confirmed.body.stockConflict.resolvedAt).not.toBeNull()
            expect(confirmed.body.stockConflict.resolvedById).toBe(USERS.editor.id)
            expect(confirmed.body.stockConflict.lines[0]).toMatchObject({ reserved: 1 })
            expect(confirmed.body.history.at(-1).note).toBe(
                'Pago confirmado; el stock que faltaba ya estaba disponible.',
            )
            expect(db.variantStock('v-m')).toBe(1)
            expect(db.stock('tee-001')).toBe(1)
        })

        it('still needs the acknowledgement after a partial restock, with the current numbers', async () => {
            db.setVariantStock('v-m', 2)
            const order = await createOrder([
                { productId: 'tee-001', variantId: 'v-m', quantity: 2 },
            ])
            await expire(order.code)
            db.setVariantStock('v-m', 0)
            await payment(order.code, order.accessToken, { amountBs: '1' }).expect(200)

            db.setVariantStock('v-m', 1)
            const detail = await request(app.getHttpServer())
                .get(`/api/admin/orders/${order.code}`)
                .set('Cookie', cookie('editor'))
                .expect(200)
            expect(detail.body.stockConflict).toMatchObject({
                stillShort: true,
                lines: [{ requested: 2, reserved: 0, available: 1, stillShort: true }],
            })

            const refused = await admin(order.code, '/transitions', 'editor', {
                to: 'PAGO_VERIFICADO',
            }).expect(400)
            expect(refused.body.code).toBe('STOCK_CONFLICT_UNACKNOWLEDGED')
            expect(refused.body.message).toBe(
                'Falta stock para este pedido («Khamrah – M» pidió 2, hay 1). Confirma que lo entiendes para continuar.',
            )
            expect(refused.body.lines).toMatchObject([{ variantId: 'v-m', available: 1 }])
            expect(db.variantStock('v-m')).toBe(1)

            const confirmed = await admin(order.code, '/transitions', 'editor', {
                to: 'PAGO_VERIFICADO',
                acknowledgeStockConflict: true,
            }).expect(200)
            expect(confirmed.body.stockConflict.lines[0]).toMatchObject({
                requested: 2,
                reserved: 1,
            })
            expect(confirmed.body.history.at(-1).note).toBe(
                'Pago confirmado con stock insuficiente: «Khamrah – M» faltan 1 unidad.',
            )
            expect(db.variantStock('v-m')).toBe(0)
        })

        it('caps a legacy conflict line (no variantId) over all the variants of its product', async () => {
            const order = await createOrder([
                { productId: 'mug-001', variantId: 'v-15oz', quantity: 2 },
                { productId: 'mug-001', variantId: 'v-11oz', quantity: 1 },
            ])
            orderRow(order.code).stockConflict = {
                detectedAt: new Date().toISOString(),
                lines: [
                    {
                        productId: 'mug-001',
                        productName: MUG,
                        requested: 3,
                        available: 1,
                        reserved: 1,
                    },
                ],
                resolvedAt: null,
                resolvedById: null,
            }
            await admin(order.code, '/transitions', 'admin', {
                to: 'CANCELADO',
                note: 'Duplicado',
            }).expect(200)
            // Only 1 unit was held: it goes back to the first line's variant.
            expect([db.variantStock('v-15oz'), db.variantStock('v-11oz')]).toEqual([4, 2])
        })
    })

    it('reactivates a cancelled order only for ADMIN and only if never paid', async () => {
        const order = await createOrder()
        await admin(order.code, '/transitions', 'admin', {
            to: 'CANCELADO',
            note: 'Duplicado',
        }).expect(200)
        expect(db.variantStock('v-15oz')).toBe(5)
        await admin(order.code, '/transitions', 'editor', { to: 'PENDIENTE_PAGO' }).expect(403)
        const detail = await admin(order.code, '/transitions', 'admin', {
            to: 'PENDIENTE_PAGO',
        }).expect(200)
        expect(detail.body.status).toBe('PENDIENTE_PAGO')
        expect(db.variantStock('v-15oz')).toBe(3)

        const paid = await createOrder()
        await payment(paid.code, paid.accessToken, { amountBs: '30760.69' }).expect(200)
        await admin(paid.code, '/transitions', 'editor', { to: 'PAGO_VERIFICADO' }).expect(200)
        const cancelled = await admin(paid.code, '/transitions', 'admin', {
            to: 'CANCELADO',
            note: 'Cliente desistió',
            refundStatus: 'REEMBOLSADO',
            refundReference: '998877',
        }).expect(200)
        expect(cancelled.body.refund).toMatchObject({ status: 'REEMBOLSADO', reference: '998877' })
        expect(cancelled.body.allowedTransitions).toEqual([])
        const again = await admin(paid.code, '/transitions', 'admin', {
            to: 'PENDIENTE_PAGO',
        }).expect(409)
        expect(again.body.message).toBe(
            'Este pedido tuvo un pago verificado, así que no se puede reactivar.',
        )
    })

    it('refuses the retired personalization and design fields on a cart line', async () => {
        const refused = await request(app.getHttpServer())
            .post('/api/orders')
            .send(
                checkout({
                    items: [
                        {
                            productId: 'mug-001',
                            variantId: 'v-11oz',
                            quantity: 1,
                            personalization: 'Ana',
                            designId: 'd1',
                        },
                    ],
                }),
            )
            .expect(400)
        expect(refused.body.details).toEqual([
            {
                field: 'items.0.personalization',
                errors: ['El campo "personalization" no está permitido.'],
            },
            { field: 'items.0.designId', errors: ['El campo "designId" no está permitido.'] },
        ])
    })

    it('validates the payment form and the proof type', async () => {
        const order = (
            await request(app.getHttpServer()).post('/api/orders').send(checkout()).expect(201)
        ).body
        const invalid = await payment(order.code, order.accessToken, {
            reference: '12',
            payerBankCode: 'abc',
            payerPhone: '12345',
            amountBs: 'mucho',
        }).expect(400)
        expect(invalid.body.details.map((detail: Row) => detail.field).sort()).toEqual([
            'amountBs',
            'payerBankCode',
            'payerPhone',
            'reference',
        ])

        // Only the last 6 digits of the bank reference: no more, no less.
        for (const reference of ['12345', '1234567', '0012345678']) {
            const wrong = await payment(order.code, order.accessToken, {
                reference,
                amountBs: '1',
            }).expect(400)
            expect(wrong.body.details).toEqual([
                { field: 'reference', errors: ['La referencia debe tener exactamente 6 dígitos.'] },
            ])
        }

        // Four digits, but not an active bank of the catalog: unknown, or deactivated (0104).
        for (const payerBankCode of ['9999', '0104']) {
            const bank = await payment(order.code, order.accessToken, {
                payerBankCode,
                amountBs: '1',
            }).expect(400)
            expect(bank.body.details).toEqual([
                { field: 'payerBankCode', errors: ['Elige el banco desde el que pagaste.'] },
            ])
        }
        expect(db.table(OrderPayment)).toHaveLength(0)

        const future = await payment(order.code, order.accessToken, {
            paidOn: '2999-01-01',
            amountBs: '1',
        }).expect(400)
        expect(future.body.details).toEqual([
            { field: 'paidOn', errors: ['La fecha del pago no puede estar en el futuro.'] },
        ])

        const fake = await payment(order.code, order.accessToken, { amountBs: '1' })
            .attach('proof', Buffer.from('<svg/>'), { filename: 'x.png', contentType: 'image/png' })
            .expect(400)
        expect(fake.body.details).toEqual([
            { field: 'proof', errors: ['La captura debe ser una imagen JPG, PNG o WEBP.'] },
        ])
        expect(storage.uploadPrivate).not.toHaveBeenCalled()
    })

    it('takes only mobiles on an active operator code at checkout', async () => {
        const post = (phone: string) =>
            request(app.getHttpServer()).post('/api/orders').send(checkout({ phone }))

        for (const phone of ['0212-5551234', '+58 414 1234567', '04141234567', '0414-123456']) {
            const invalid = await post(phone).expect(400)
            expect(invalid.body.details).toEqual([
                {
                    field: 'phone',
                    errors: ['Escribe un celular válido, por ejemplo 0412-5550134.'],
                },
            ])
        }
        // 0426 exists in the catalog but is inactive; 0413 is not a code at all.
        for (const code of ['0426', '0413']) {
            const inactive = await post(`${code}-1234567`).expect(400)
            expect(inactive.body.details).toEqual([
                { field: 'phone', errors: [`El código ${code} no está disponible.`] },
            ])
        }
        expect(db.table(Order)).toHaveLength(0)
        await post('0424-1234567').expect(201)
    })

    it('checks the payer phone code and the cédula or RIF of the payment (customer and staff)', async () => {
        const order = await createOrder()
        const inactive = await payment(order.code, order.accessToken, {
            payerPhone: '0426-1234567',
            amountBs: '1',
        }).expect(400)
        expect(inactive.body.details).toEqual([
            { field: 'payerPhone', errors: ['El código 0426 no está disponible.'] },
        ])

        const idMessage = 'Usa V, J o G seguido de 6 a 9 números, por ejemplo V-12345678.'
        for (const payerIdNumber of ['E-12345678', 'P-1234567', 'V-12345', 'V-1234567890']) {
            const invalid = await payment(order.code, order.accessToken, {
                payerIdNumber,
                amountBs: '1',
            }).expect(400)
            expect(invalid.body.details).toEqual([{ field: 'payerIdNumber', errors: [idMessage] }])
        }
        expect(db.table(OrderPayment)).toHaveLength(0)

        const staff = (payerIdNumber: string) => {
            const req = request(app.getHttpServer())
                .post(`/api/admin/orders/${order.code}/payments`)
                .set('Cookie', cookie('editor'))
            for (const [key, value] of Object.entries({
                reference: '889900',
                payerBankCode: '0134',
                payerPhone: '0424-1234567',
                payerIdNumber,
                paidOn: caracasDay(),
                amountBs: '30760,69',
            })) {
                req.field(key, value)
            }
            return req
        }
        const staffInvalid = await staff('E-12345678').expect(400)
        expect(staffInvalid.body.details).toEqual([{ field: 'payerIdNumber', errors: [idMessage] }])

        // Lowercase is uppercased; an empty cédula is simply not sent.
        await payment(order.code, order.accessToken, {
            payerIdNumber: 'v-12345678',
            amountBs: '1',
        }).expect(200)
        expect(db.table(OrderPayment)[0]).toMatchObject({ payerIdNumber: 'V-12345678' })

        await admin(order.code, '/transitions', 'admin', {
            to: 'PAGO_RECHAZADO',
            note: 'Monto incompleto',
        }).expect(200)
        await staff('J-123456789').expect(200)
        expect(db.table(OrderPayment)[1]).toMatchObject({ payerIdNumber: 'J-123456789' })
    })

    it('filters the admin list by one or several statuses', async () => {
        for (let index = 0; index < 3; index += 1) {
            await request(app.getHttpServer())
                .post('/api/orders')
                .send(
                    checkout({
                        items: [{ productId: 'mug-001', variantId: 'v-11oz', quantity: 1 }],
                    }),
                )
                .expect(201)
        }
        const [first, second, third] = db.table(Order)
        Object.assign(first as Row, { status: 'PENDIENTE_VERIFICACION' })
        Object.assign(second as Row, { status: 'PAGO_RECHAZADO' })
        Object.assign(third as Row, { status: 'PENDIENTE_PAGO' })

        const list = (query: string) =>
            request(app.getHttpServer())
                .get(`/api/admin/orders${query}`)
                .set('Cookie', cookie('editor'))
        const codes = (body: { items: { code: string }[] }) => body.items.map((row) => row.code)

        const single = (await list('?status=PENDIENTE_VERIFICACION').expect(200)).body
        expect(codes(single)).toEqual([first?.code])
        expect(single.total).toBe(1)
        // The counts ignore the status filter, so every tab can show its number.
        expect(single.countAll).toBe(3)
        expect(single.counts).toMatchObject({
            PENDIENTE_VERIFICACION: 1,
            PAGO_RECHAZADO: 1,
            PENDIENTE_PAGO: 1,
            ENTREGADO: 0,
        })

        const csv = (await list('?status=PENDIENTE_PAGO,PAGO_RECHAZADO').expect(200)).body
        expect(codes(csv)).toEqual([third?.code, second?.code])
        const repeated = (await list('?status=PENDIENTE_PAGO&status=PAGO_RECHAZADO').expect(200))
            .body
        expect(codes(repeated)).toEqual(codes(csv))
        expect((await list('').expect(200)).body.total).toBe(3)

        const invalid = await list('?status=PENDIENTE_PAGO,PAGADO').expect(400)
        expect(invalid.body.details).toEqual([
            {
                field: 'status',
                errors: [expect.stringMatching(/^El estado no es válido\. Usa uno o varios de /)],
            },
        ])
    })

    it('keeps the admin API behind a session', async () => {
        await request(app.getHttpServer()).get('/api/admin/orders/KZ-000001').expect(401)
        await request(app.getHttpServer())
            .get('/api/admin/orders/KZ-000001/payments/p/proof')
            .expect(401)
        await request(app.getHttpServer())
            .post('/api/admin/exchange-rate/manual')
            .send({ rate: 1 })
            .expect(401)
        await request(app.getHttpServer())
            .post('/api/admin/exchange-rate/manual')
            .set('Cookie', cookie('editor'))
            .send({ rate: 1 })
            .expect(403)
        expect(DEFAULT_SITE_CONTENT.payment.bankCode).toBe('')
    })

    describe('checkout retries (Idempotency-Key)', () => {
        const KEY = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
        const post = (body: Row, key?: string) => {
            const req = request(app.getHttpServer()).post('/api/orders')
            if (key !== undefined) req.set('Idempotency-Key', key)
            return req.send(body)
        }

        it('returns the same order for a retry, taking the stock once', async () => {
            const first = await post(checkout(), KEY).expect(201)
            expect(first.body).toMatchObject({ code: 'KZ-000001', replayed: false })
            expect(db.variantStock('v-15oz')).toBe(3)
            expect(db.table(Order)[0]).toMatchObject({ idempotencyKey: KEY })
            expect(db.table(Order)[0]?.idempotencyHash).toMatch(/^[a-f0-9]{64}$/)

            // Even once the rate went stale: the retry never re-prices anything.
            db.table(ExchangeRate)[0]!.effectiveDate = '2020-01-01'
            // Same body, other key order and email case: the same request.
            const { items, ...rest } = checkout({ email: 'ANA@example.com' })
            const retry = await post({ items, ...rest }, KEY).expect(200)
            expect(retry.body).toMatchObject({ code: 'KZ-000001', replayed: true })
            expect(retry.body.order).toEqual(first.body.order)
            expect(retry.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
            expect(retry.body.accessToken).not.toBe(first.body.accessToken)

            expect(db.table(Order)).toHaveLength(1)
            expect(db.variantStock('v-15oz')).toBe(3)
            expect(events.map((event) => event.name)).toEqual([ORDER_EVENTS.created])
            // Both links open the order.
            for (const token of [first.body.accessToken, retry.body.accessToken]) {
                await request(app.getHttpServer())
                    .get(`/api/orders/KZ-000001?t=${token}`)
                    .expect(200)
            }
        })

        it('refuses the same key with another body (409)', async () => {
            await post(checkout(), KEY).expect(201)
            const other = await post(checkout({ address: 'Otra dirección 123' }), KEY).expect(409)
            expect(other.body).toMatchObject({
                code: 'IDEMPOTENCY_KEY_REUSED',
                message:
                    'Este intento de compra ya se usó con otros datos. Recarga la página e intenta de nuevo.',
            })
            expect(db.table(Order)).toHaveLength(1)
            expect(db.variantStock('v-15oz')).toBe(3)
        })

        it('creates one order per request without the header, as before', async () => {
            const first = await post(checkout()).expect(201)
            const second = await post(checkout(), '').expect(201)
            expect([first.body.code, second.body.code]).toEqual(['KZ-000001', 'KZ-000002'])
            expect(second.body.replayed).toBe(false)
            expect(db.variantStock('v-15oz')).toBe(1)
            expect(db.table(Order).map((order) => order.idempotencyKey)).toEqual([null, null])
        })

        it('refuses a malformed key', async () => {
            for (const key of ['short', 'x'.repeat(65), 'has spaces in the key!!']) {
                const response = await post(checkout(), key).expect(400)
                expect(response.body.details).toEqual([
                    {
                        field: 'Idempotency-Key',
                        errors: [
                            'El identificador del intento de compra no es válido. Recarga la página.',
                        ],
                    },
                ])
            }
            expect(db.table(Order)).toHaveLength(0)
        })

        it('answers concurrent duplicates with one order (the loser is rolled back)', async () => {
            db.isolatedTransactions = true
            const [a, b] = await Promise.all([post(checkout(), KEY), post(checkout(), KEY)])
            expect([a.status, b.status].sort()).toEqual([200, 201])
            expect(a.body.code).toBe(b.body.code)
            expect(db.table(Order)).toHaveLength(1)
            expect(db.variantStock('v-15oz')).toBe(3)
            expect(db.stock('mug-001')).toBe(6)
        })

        it('replays when the unique index catches a retry that missed the lookup', async () => {
            db.isolatedTransactions = true
            await post(checkout(), KEY).expect(201)
            // The retry's lookup runs before the first request commits: it finds nothing.
            const getRepository = db.dataSource.getRepository
            let missed = false
            db.dataSource.getRepository = (entity: unknown) => {
                const repository = getRepository(entity)
                if (entity !== Order || missed) return repository
                return {
                    ...repository,
                    findOne: (options: { where?: Row }) => {
                        if (options.where?.idempotencyKey && !missed) {
                            missed = true
                            return Promise.resolve(null)
                        }
                        return (
                            repository as { findOne: (o: unknown) => Promise<unknown> }
                        ).findOne(options)
                    },
                } as ReturnType<typeof getRepository>
            }

            const retry = await post(checkout(), KEY).expect(200)
            expect(missed).toBe(true)
            expect(retry.body).toMatchObject({ code: 'KZ-000001', replayed: true })
            expect(db.table(Order)).toHaveLength(1)
            // The losing transaction took stock and inserted rows; all of it was rolled back.
            expect(db.variantStock('v-15oz')).toBe(3)
            expect(db.table(OrderAccessLink)).toHaveLength(2)
        })

        it('frees a key older than 24 hours and creates a new order', async () => {
            await post(checkout(), KEY).expect(201)
            db.table(Order)[0]!.createdAt = new Date(Date.now() - 25 * 60 * 60_000)
            const later = await post(checkout({ address: 'Otra dirección 123' }), KEY).expect(201)
            expect(later.body).toMatchObject({ code: 'KZ-000002', replayed: false })
            expect(db.table(Order).map((order) => order.idempotencyKey)).toEqual([null, KEY])
            expect(db.variantStock('v-15oz')).toBe(1)
        })
    })
})
