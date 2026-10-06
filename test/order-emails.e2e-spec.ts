import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { MAIL_TRANSPORT, type MailTransport, type OutgoingMail } from '../src/mail/mail.types.js'
import { OrderLookupService } from '../src/orders/emails/order-lookup.service.js'
import { OrderAccessLink } from '../src/orders/entities/order-access-link.entity.js'
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.service.js'
import { FakeDb, type Row } from './fixtures/fake-orders-db.js'

/** Catches every email instead of sending it. `delivers: false` behaves like MAIL_DRIVER=log. */
class FakeMailTransport implements MailTransport {
    readonly driver = 'smtp' as const
    delivers = true
    fail = false
    sent: OutgoingMail[] = []

    send(message: OutgoingMail): Promise<void> {
        if (this.fail) return Promise.reject(new Error(`550 ${message.to}: mailbox unavailable`))
        this.sent.push(message)
        return Promise.resolve()
    }
}

const LOOKUP_REQUESTED = { message: 'Si los datos coinciden, te enviamos un enlace a tu correo.' }

/** The private link of an email ("Ver mi pedido: <url>" in the text part). */
function linkOf(mail: OutgoingMail): { url: string; token: string } {
    const url = /Ver mi pedido: (\S+)/.exec(mail.text)?.[1]
    if (!url) throw new Error('No link in the email')
    return { url, token: new URL(url).searchParams.get('t') as string }
}

describe('Customer emails: "Pedido recibido" and "Consultar mi pedido" (e2e)', () => {
    let app: INestApplication
    let db: FakeDb
    let mail: FakeMailTransport
    let lookups: OrderLookupService
    const storage = {
        driver: 'local' as const,
        upload: vi.fn(),
        delete: vi.fn(),
        uploadPrivate: vi.fn(),
        readPrivate: vi.fn(),
        deletePrivate: vi.fn(),
    }

    const http = () => request(app.getHttpServer())

    const createOrder = async (overrides: Row = {}) =>
        (
            await http()
                .post('/api/orders')
                .send({
                    fullName: 'Ana María Pérez',
                    email: 'Ana@Example.com',
                    phone: '0414-1234567',
                    city: 'Caracas',
                    address: 'Av. Principal, casa 4',
                    notes: '',
                    deliveryMethod: 'delivery',
                    items: [
                        {
                            productId: 'mug-001',
                            variantId: 'v-15oz',
                            quantity: 2,
                        },
                    ],
                    ...overrides,
                })
                .expect(201)
        ).body as { code: string; accessToken: string }

    const lookup = (code: string, email: string) =>
        http().post('/api/orders/lookup').send({ code, email })

    /** The listener runs after the response; waits until `count` emails were caught. */
    const emails = async (count: number): Promise<OutgoingMail[]> => {
        for (let tries = 0; mail.sent.length < count && tries < 100; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return mail.sent
    }

    /** Lets the order.created listener finish (it may send nothing). */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

    beforeEach(async () => {
        db = new FakeDb()
        mail = new FakeMailTransport()
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(db.dataSource)
            .overrideProvider(STORAGE_SERVICE)
            .useValue(storage as unknown as StorageService)
            .overrideProvider(MAIL_TRANSPORT)
            .useValue(mail)
            .compile()
        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.use(cookieParser())
        app.useGlobalPipes(createValidationPipe())
        await app.init()
        lookups = app.get(OrderLookupService)
    })

    afterEach(async () => {
        await app.close()
    })

    describe('Pedido recibido', () => {
        it('emails the customer a summary with a new private link (never the checkout token)', async () => {
            const order = await createOrder()
            const [email] = await emails(1)

            expect(mail.sent).toHaveLength(1)
            expect(email!.to).toBe('ana@example.com')
            expect(email!.subject).toBe(`Recibimos tu pedido ${order.code}`)
            expect(email!.text).toContain('¡GRACIAS POR TU PEDIDO, ANA!')
            expect(email!.text).toContain('Lattafa Khamrah · 15 oz — $32,00')
            expect(email!.text).toContain('Banco: 0134 - Banesco')
            expect(email!.text).toContain('Dirección: Av. Principal, casa 4, Caracas')

            const { url, token } = linkOf(email!)
            expect(url).toContain(`/pedido/${order.code}?t=`)
            expect(token).not.toBe(order.accessToken)
            const links = db.table(OrderAccessLink)
            expect(links).toHaveLength(2)
            expect(links[1]).toMatchObject({ createdById: null, revokedAt: null })
            expect(links.map((link) => link.tokenHash)).not.toContain(token)
            await http().get(`/api/orders/${order.code}?t=${token}`).expect(200)
            await http().get(`/api/orders/${order.code}?t=${order.accessToken}`).expect(200)
        })

        it('a mail failure never affects the order', async () => {
            mail.fail = true
            const order = await createOrder()
            await settle()
            expect(mail.sent).toHaveLength(0)
            await http().get(`/api/orders/${order.code}?t=${order.accessToken}`).expect(200)
        })

        it('does nothing when mail is off (MAIL_DRIVER=log): no email, no extra link', async () => {
            mail.delivers = false
            await createOrder()
            await settle()
            expect(mail.sent).toHaveLength(0)
            expect(db.table(OrderAccessLink)).toHaveLength(1)
        })
    })

    describe('Consultar mi pedido', () => {
        it('emails a fresh link when the code and the email match (case and spaces ignored)', async () => {
            const order = await createOrder()
            await emails(1)
            mail.sent = []

            const response = await lookup(` ${order.code.toLowerCase()} `, '  ANA@example.COM ')
                .expect(202)
                .expect('Cache-Control', 'no-store')
            expect(response.body).toEqual(LOOKUP_REQUESTED)
            await lookups.idle()

            expect(mail.sent).toHaveLength(1)
            const email = mail.sent[0]!
            expect(email.to).toBe('ana@example.com')
            expect(email.subject).toBe(`Tu enlace para ver el pedido ${order.code}`)
            const { token } = linkOf(email)
            expect(db.table(OrderAccessLink)).toHaveLength(3)
            await http().get(`/api/orders/${order.code}?t=${token}`).expect(200)
        })

        it('answers the same and sends nothing when there is no match', async () => {
            const order = await createOrder()
            await emails(1)
            mail.sent = []

            const wrongEmail = await lookup(order.code, 'otra@example.com').expect(202)
            const unknownCode = await lookup('KZ-999999', 'ana@example.com').expect(202)
            expect(wrongEmail.body).toEqual(LOOKUP_REQUESTED)
            expect(unknownCode.body).toEqual(LOOKUP_REQUESTED)
            await lookups.idle()
            expect(mail.sent).toHaveLength(0)
            expect(db.table(OrderAccessLink)).toHaveLength(2)
        })

        it('issues nothing for a match while mail is off', async () => {
            mail.delivers = false
            const order = await createOrder()
            await lookup(order.code, 'ana@example.com').expect(202)
            await lookups.idle()
            expect(mail.sent).toHaveLength(0)
            expect(db.table(OrderAccessLink)).toHaveLength(1)
        })

        it('validates the code and the email in Spanish', async () => {
            const bad = await lookup('123', 'no-es-correo').expect(400)
            expect(bad.body.details).toEqual([
                {
                    field: 'code',
                    errors: ['El código del pedido debe tener el formato KZ-000123.'],
                },
                {
                    field: 'email',
                    errors: ['El correo debe ser un correo válido, por ejemplo hola@correo.com.'],
                },
            ])
            await http().post('/api/orders/lookup').send({ code: 'KZ-000001' }).expect(400)
        })

        it('limits lookups to 3 per email and 3 per code every 15 minutes', async () => {
            for (let index = 0; index < 3; index++) {
                await lookup(`KZ-00000${index + 1}`, 'ana@example.com').expect(202)
            }
            const limited = await lookup('KZ-000009', 'ANA@example.com').expect(429)
            expect(limited.body.message).toBe(
                'Hiciste muchas consultas seguidas. Espera unos minutos e intenta de nuevo.',
            )
            await lookups.idle()
        })

        it('limits lookups per code across emails', async () => {
            for (let index = 0; index < 3; index++) {
                await lookup('KZ-000001', `persona${index}@example.com`).expect(202)
            }
            await lookup('kz-000001', 'otra@example.com').expect(429)
            await lookups.idle()
        })

        it('limits lookups to 5 per IP every 15 minutes', async () => {
            for (let index = 0; index < 5; index++) {
                await lookup(`KZ-00001${index}`, `persona${index}@example.com`).expect(202)
            }
            await lookup('KZ-000020', 'otra@example.com').expect(429)
            await lookups.idle()
        })
    })
})
