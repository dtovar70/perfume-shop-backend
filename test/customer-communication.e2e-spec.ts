import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { caracasDay } from '../src/common/utils/caracas-date.js'
import { OrderAccessLink } from '../src/orders/entities/order-access-link.entity.js'
import { OrderNote } from '../src/orders/entities/order-note.entity.js'
import { Order } from '../src/orders/entities/order.entity.js'
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.service.js'
import { FakeDb, USERS, type Row } from './fixtures/fake-orders-db.js'

/** Binary body of a supertest response (PDF). */
function binary(res: request.Response, callback: (error: Error | null, body: Buffer) => void) {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => callback(null, Buffer.concat(chunks)))
}

describe('Customer communication: access links, WhatsApp messages and receipts (e2e)', () => {
    let app: INestApplication
    let db: FakeDb
    let siteUrl: string
    let cookie: (user: keyof typeof USERS) => string
    const storage = {
        driver: 'local' as const,
        upload: vi.fn(),
        delete: vi.fn(),
        uploadPrivate: vi.fn().mockResolvedValue({ key: 'payment-proofs/proof.png' }),
        readPrivate: vi.fn(),
        deletePrivate: vi.fn().mockResolvedValue(undefined),
    }

    const http = () => request(app.getHttpServer())

    const checkout = (overrides: Row = {}) => ({
        fullName: 'Ana María Pérez',
        email: 'ana@example.com',
        phone: '0414-1234567',
        city: 'Caracas',
        address: 'Av. Principal, casa 4',
        notes: '',
        deliveryMethod: 'delivery',
        items: [{ productId: 'perfume-001', variantId: 'v-15oz', quantity: 2 }],
        ...overrides,
    })

    const createOrder = async (overrides: Row = {}) =>
        (await http().post('/api/orders').send(checkout(overrides)).expect(201)).body as {
            code: string
            accessToken: string
        }

    const pay = (code: string, token: string) => {
        const req = http().post(`/api/orders/${code}/payment?t=${token}`)
        const values: Row = {
            reference: '123456',
            payerBankCode: '0102',
            payerPhone: '0414-1234567',
            paidOn: caracasDay(),
            amountBs: '30760.69',
        }
        for (const [key, value] of Object.entries(values)) req.field(key, String(value))
        return req.expect(200)
    }

    const admin = (method: 'get' | 'post' | 'patch', path: string, user: keyof typeof USERS) =>
        http()[method](`/api${path}`).set('Cookie', cookie(user))

    const transition = (code: string, to: string, note?: string) =>
        admin('post', `/admin/orders/${code}/transitions`, 'admin')
            .send(note ? { to, note } : { to })
            .expect(200)

    beforeEach(async () => {
        db = new FakeDb()
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

        const config = app.get(ConfigService)
        siteUrl = config.get<string>('PUBLIC_SITE_URL') ?? ''
        const signer = new JwtService({ secret: config.get<string>('JWT_SECRET') })
        cookie = (user) =>
            `kz_session=${signer.sign({ sub: USERS[user].id, role: USERS[user].role }, { expiresIn: 600 })}`
    })

    afterEach(async () => {
        await app.close()
    })

    describe('access links', () => {
        it('issues extra links that work next to the checkout one, and 404s anything else', async () => {
            const order = await createOrder()

            await http().post(`/api/admin/orders/${order.code}/access-links`).expect(401)
            const issued = await admin('post', `/admin/orders/${order.code}/access-links`, 'editor')
                .expect(201)
                .expect('Cache-Control', 'no-store')
            const { token, url } = issued.body as { token: string; url: string }
            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
            expect(token).not.toBe(order.accessToken)
            expect(url).toBe(`${siteUrl}/pedido/${order.code}?t=${token}`)

            const links = db.table(OrderAccessLink)
            expect(links).toHaveLength(2)
            expect(links[1]).toMatchObject({ createdById: USERS.editor.id, revokedAt: null })
            expect(links.map((link) => link.tokenHash)).not.toContain(token)

            // Old and new links both open the order.
            await http().get(`/api/orders/${order.code}?t=${order.accessToken}`).expect(200)
            await http().get(`/api/orders/${order.code}?t=${token}`).expect(200)

            // A revoked link, a wrong token or another order's code: plain 404.
            links[0]!.revokedAt = new Date()
            await http().get(`/api/orders/${order.code}?t=${order.accessToken}`).expect(404)
            await http().get(`/api/orders/${order.code}?t=${token}`).expect(200)
            await http()
                .get(`/api/orders/${order.code}?t=${'A'.repeat(43)}`)
                .expect(404)
            const other = await createOrder()
            await http().get(`/api/orders/${other.code}?t=${token}`).expect(404)

            await admin('post', '/admin/orders/KZ-999999/access-links', 'admin').expect(404)
        })
    })

    describe('WhatsApp message', () => {
        it('renders the rejection template with the reason and a working fresh link', async () => {
            const order = await createOrder()
            await pay(order.code, order.accessToken)
            await transition(order.code, 'PAGO_RECHAZADO', 'La referencia no coincide.')

            const { body } = await admin(
                'post',
                `/admin/orders/${order.code}/whatsapp-message`,
                'editor',
            ).expect(200)
            expect(body).toMatchObject({
                status: 'PAGO_RECHAZADO',
                statusLabel: 'Pago rechazado',
                phone: '584141234567',
                receiptUrl: null,
            })
            expect(body.link).toMatch(new RegExp(`^${siteUrl}/pedido/${order.code}\\?t=`))
            expect(body.text).toBe(
                `Hola Ana 👋 Revisamos el pago de tu pedido ${order.code} y no pudimos aprobarlo: La referencia no coincide. Puedes subir un nuevo comprobante aquí: ${body.link}`,
            )
            expect(body.url).toBe(
                `https://wa.me/584141234567?text=${encodeURIComponent(body.text)}`,
            )

            // The fresh link opens the customer's order.
            const token = new URL(body.link as string).searchParams.get('t')
            await http().get(`/api/orders/${order.code}?t=${token}`).expect(200)

            // Opening WhatsApp leaves an internal note; the status does not change.
            const opened = await admin(
                'post',
                `/admin/orders/${order.code}/whatsapp-message/opened`,
                'editor',
            ).expect(200)
            expect(opened.body.status).toBe('PAGO_RECHAZADO')
            expect(opened.body.notes[0].body).toBe(
                'Aviso por WhatsApp preparado (estado Pago rechazado).',
            )
            expect(db.table(OrderNote)).toHaveLength(1)
        })

        it('offers no wa.me link when the phone is not a mobile', async () => {
            const order = await createOrder()
            // Checkout only takes mobiles now; orders placed before that may hold a landline.
            const stored = db.table(Order).find((row) => row.code === order.code)
            if (stored) stored.customerPhone = '0212-5551234'
            const { body } = await admin(
                'post',
                `/admin/orders/${order.code}/whatsapp-message`,
                'admin',
            ).expect(200)
            expect(body).toMatchObject({ phone: null, url: null, customerPhone: '0212-5551234' })
            expect(body.text).toContain('$36,00 (Bs. 30.760,69)')
            expect(body.text).toContain('KaiZen')
        })

        it('includes the receipt link once the payment is verified', async () => {
            const order = await createOrder()
            await pay(order.code, order.accessToken)
            await transition(order.code, 'PAGO_VERIFICADO')

            const { body } = await admin(
                'post',
                `/admin/orders/${order.code}/whatsapp-message`,
                'admin',
            ).expect(200)
            const token = new URL(body.link as string).searchParams.get('t')
            expect(body.receiptUrl).toMatch(
                new RegExp(`/api/orders/${order.code}/receipt\\.pdf\\?t=${token}$`),
            )
            expect(body.text).toContain(
                `Tu comprobante: ${body.receiptUrl} · Sigue tu pedido: ${body.link}`,
            )
        })

        it('validates template placeholders and uses the edited template for the next message', async () => {
            const patch = (code: string, whatsappTemplate: string) =>
                admin('patch', `/admin/catalogs/order-statuses/${code}`, 'admin').send({
                    whatsappTemplate,
                })

            const unknown = await patch(
                'PENDIENTE_PAGO',
                'Hola {cliente}, tu pedido {pedido}',
            ).expect(400)
            expect(unknown.body.details).toEqual([
                {
                    field: 'whatsappTemplate',
                    errors: [
                        'El mensaje de WhatsApp usa un marcador desconocido: {cliente}. Solo se admiten {nombre}, {pedido}, {enlace}, {total}, {motivo}, {marca}, {envio}, {comprobante}.',
                    ],
                },
            ])
            const receipt = await patch('PENDIENTE_PAGO', 'Tu comprobante: {comprobante}').expect(
                400,
            )
            expect(receipt.body.details[0].errors).toEqual([
                'El marcador {comprobante} solo se puede usar en los estados con el pago verificado.',
            ])
            await patch('PENDIENTE_PAGO', 'x'.repeat(1001)).expect(400)
            await admin('patch', '/admin/catalogs/order-statuses/PENDIENTE_PAGO', 'editor')
                .send({ whatsappTemplate: 'Hola' })
                .expect(403)

            const saved = await patch(
                'PENDIENTE_PAGO',
                '  Hola {nombre}, recuerda pagar {total} de tu pedido {pedido}.  ',
            ).expect(200)
            expect(
                saved.body.statuses.find((status: Row) => status.code === 'PENDIENTE_PAGO')
                    .whatsappTemplate,
            ).toBe('Hola {nombre}, recuerda pagar {total} de tu pedido {pedido}.')

            // The public catalog never carries the templates.
            const publicCatalog = await http().get('/api/catalogs/order-statuses').expect(200)
            expect(publicCatalog.body.statuses[0]).not.toHaveProperty('whatsappTemplate')

            const order = await createOrder()
            const { body } = await admin(
                'post',
                `/admin/orders/${order.code}/whatsapp-message`,
                'admin',
            ).expect(200)
            expect(body.text).toBe(
                `Hola Ana, recuerda pagar $36,00 (Bs. 30.760,69) de tu pedido ${order.code}.`,
            )
            // No {enlace} in the template: no link was issued.
            expect(body.link).toBeNull()
            expect(db.table(OrderAccessLink)).toHaveLength(1)
        })
    })

    describe('receipt PDF', () => {
        it('is a 409 until the payment is verified, 404 with a bad token, then a PDF download', async () => {
            const order = await createOrder()
            const receipt = (token: string) =>
                http().get(`/api/orders/${order.code}/receipt.pdf?t=${token}`)

            const early = await receipt(order.accessToken).expect(409)
            expect(early.body.message).toBe(
                'El comprobante de compra estará disponible cuando verifiquemos el pago del pedido.',
            )
            await admin('get', `/admin/orders/${order.code}/receipt.pdf`, 'editor').expect(409)
            await pay(order.code, order.accessToken)
            await receipt(order.accessToken).expect(409)
            let view = await http().get(`/api/orders/${order.code}?t=${order.accessToken}`)
            expect(view.body.receiptAvailable).toBe(false)

            await transition(order.code, 'PAGO_VERIFICADO')
            await receipt('B'.repeat(43)).expect(404)
            await receipt('').expect(404)
            view = await http().get(`/api/orders/${order.code}?t=${order.accessToken}`)
            expect(view.body.receiptAvailable).toBe(true)

            const pdf = await receipt(order.accessToken)
                .buffer(true)
                .parse(binary)
                .expect(200)
                .expect('Content-Type', 'application/pdf')
                .expect(
                    'Content-Disposition',
                    `attachment; filename="comprobante-${order.code}.pdf"`,
                )
                .expect('Cache-Control', 'private, no-store')
            const bytes = pdf.body as Buffer
            expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
            expect(bytes.length).toBeGreaterThan(5_000)

            const adminPdf = await admin('get', `/admin/orders/${order.code}/receipt.pdf`, 'editor')
                .buffer(true)
                .parse(binary)
                .expect(200)
                .expect('Content-Type', 'application/pdf')
            expect((adminPdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
            await http().get(`/api/admin/orders/${order.code}/receipt.pdf`).expect(401)
        })

        it('prints a QR: the customer link it came from, or one admin link reused for 24 h', async () => {
            const order = await createOrder()
            await admin('get', `/admin/orders/${order.code}/receipt.pdf`, 'editor').expect(409)
            // A refused receipt never leaves a stray link behind.
            expect(db.table(OrderAccessLink)).toHaveLength(1)
            await pay(order.code, order.accessToken)
            await transition(order.code, 'PAGO_VERIFICADO')

            // The customer's receipt uses their own token: no new link.
            await http()
                .get(`/api/orders/${order.code}/receipt.pdf?t=${order.accessToken}`)
                .expect(200)
            expect(db.table(OrderAccessLink)).toHaveLength(1)

            const download = () =>
                admin('get', `/admin/orders/${order.code}/receipt.pdf`, 'editor')
                    .buffer(true)
                    .parse(binary)
                    .expect(200)
            const first = (await download()).body as Buffer
            expect(first.toString('latin1')).toMatch(/\/Subtype \/Image/)
            const links = db.table(OrderAccessLink)
            expect(links).toHaveLength(2)
            expect(links[1]).toMatchObject({ createdById: USERS.editor.id, revokedAt: null })

            // Downloading again reuses that admin link instead of issuing another one.
            await download()
            await admin('get', `/admin/orders/${order.code}/receipt.pdf`, 'admin').expect(200)
            expect(db.table(OrderAccessLink)).toHaveLength(2)

            // A revoked link is not reused.
            ;(links[1] as Row).revokedAt = new Date()
            await download()
            expect(db.table(OrderAccessLink)).toHaveLength(3)
        })

        it('is gone once the order is cancelled', async () => {
            const order = await createOrder()
            await pay(order.code, order.accessToken)
            await transition(order.code, 'PAGO_VERIFICADO')
            await admin('post', `/admin/orders/${order.code}/transitions`, 'admin')
                .send({ to: 'CANCELADO', note: 'Cliente desistió', refundStatus: 'PENDIENTE' })
                .expect(200)
            expect(db.table(Order)[0]?.status).toBe('CANCELADO')

            const cancelled = await http()
                .get(`/api/orders/${order.code}/receipt.pdf?t=${order.accessToken}`)
                .expect(409)
            expect(cancelled.body.message).toBe(
                'Este pedido fue cancelado, así que no tiene comprobante de compra.',
            )
            const view = await http().get(`/api/orders/${order.code}?t=${order.accessToken}`)
            expect(view.body.receiptAvailable).toBe(false)
        })
    })
})
