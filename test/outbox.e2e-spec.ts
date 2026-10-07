import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { MAIL_TRANSPORT } from '../src/mail/mail.types.js'
import { OutboxMessage } from '../src/outbox/entities/outbox-message.entity.js'
import { OUTBOX_MAX_ATTEMPTS } from '../src/outbox/outbox-backoff.js'
import { OutboxWorker } from '../src/outbox/outbox.worker.js'
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.service.js'
import { FakeMailTransport } from './fixtures/fake-mail.js'
import { FakeDb, USERS, type Row } from './fixtures/fake-orders-db.js'

/**
 * Notifications through the outbox, end to end over the fake database and mail transport: the
 * order writes its rows, the worker delivers them, retries failures with backoff, gives up after
 * the last attempt, and an admin can retry from `/admin/outbox`.
 */
describe('Outbox (e2e)', () => {
    let app: INestApplication
    let db: FakeDb
    let mail: FakeMailTransport
    let worker: OutboxWorker
    let cookie: (user: keyof typeof USERS) => string
    const storage = {
        driver: 'local' as const,
        upload: vi.fn(),
        delete: vi.fn(),
        uploadPrivate: vi.fn(),
        readPrivate: vi.fn(),
        deletePrivate: vi.fn(),
    }

    const http = () => request(app.getHttpServer())
    const rows = () => db.table(OutboxMessage)
    const onlyRow = (): Row => {
        expect(rows()).toHaveLength(1)
        return rows()[0] as Row
    }

    const createOrder = async () =>
        (
            await http()
                .post('/api/orders')
                .send({
                    fullName: 'Ana Pérez',
                    email: 'ana@example.com',
                    phone: '0414-1234567',
                    city: 'Caracas',
                    address: 'Av. Principal, casa 4',
                    notes: '',
                    deliveryMethod: 'delivery',
                    items: [{ productId: 'perfume-001', variantId: 'v-15oz', quantity: 1 }],
                })
                .expect(201)
        ).body as { code: string }

    /** Waits for the first attempt the order triggered (the worker is woken after the commit). */
    const delivered = () =>
        vi.waitFor(() => {
            expect(onlyRow().attempts).toBe(1)
            expect(onlyRow().status).not.toBe('processing')
        })

    /** Makes the row due now (skipping the backoff wait) and runs the worker. */
    const retryNow = async () => {
        onlyRow().nextAttemptAt = new Date(0)
        await worker.wake()
    }

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
        worker = app.get(OutboxWorker)

        const signer = new JwtService({ secret: app.get(ConfigService).get<string>('JWT_SECRET') })
        cookie = (user) =>
            `kz_session=${signer.sign({ sub: USERS[user].id, role: USERS[user].role }, { expiresIn: 600 })}`
    })

    afterEach(async () => {
        await app.close()
    })

    it('records the email with the order and delivers it once', async () => {
        const order = await createOrder()
        const row = onlyRow()
        expect(row).toMatchObject({
            type: 'email.order_received',
            payload: expect.objectContaining({ code: order.code }),
        })

        await delivered()
        expect(onlyRow()).toMatchObject({ status: 'sent', attempts: 1, lastError: null })
        expect(onlyRow().sentAt).toBeInstanceOf(Date)
        expect(mail.sent.map((email) => email.subject)).toEqual([
            `Recibimos tu pedido ${order.code}`,
        ])

        // A sent message is never delivered again.
        await worker.wake()
        expect(mail.sent).toHaveLength(1)
    })

    it('records nothing while mail is off (MAIL_DRIVER=log)', async () => {
        mail.delivers = false
        await createOrder()
        expect(rows()).toHaveLength(0)
    })

    it('retries a failing delivery with backoff, gives up after the last attempt, and an admin retries it', async () => {
        mail.fail = true
        await createOrder()
        await delivered()
        const first = onlyRow()
        expect(first).toMatchObject({ status: 'pending', attempts: 1 })
        expect(first.lastError).toContain('was not accepted')
        // The first retry waits 30 seconds.
        const wait = (first.nextAttemptAt as Date).getTime() - Date.now()
        expect(wait).toBeGreaterThan(25_000)
        expect(wait).toBeLessThanOrEqual(30_000)

        // Not due yet: the worker leaves it alone.
        await worker.wake()
        expect(onlyRow().attempts).toBe(1)

        for (let attempt = 2; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) await retryNow()
        expect(onlyRow()).toMatchObject({ status: 'failed', attempts: OUTBOX_MAX_ATTEMPTS })
        await retryNow()
        expect(onlyRow().attempts).toBe(OUTBOX_MAX_ATTEMPTS)
        expect(mail.sent).toHaveLength(0)

        const id = onlyRow().id as string
        const list = await http()
            .get('/api/admin/outbox?status=failed')
            .set('Cookie', cookie('admin'))
            .expect(200)
            .expect('Cache-Control', 'no-store')
        expect(list.body).toMatchObject({ total: 1, page: 1, totalPages: 1 })
        expect(list.body.items[0]).toMatchObject({
            id,
            status: 'failed',
            type: 'email.order_received',
        })
        await http().get('/api/admin/outbox').set('Cookie', cookie('editor')).expect(403)
        await http()
            .post(`/api/admin/outbox/${id}/retry`)
            .set('Cookie', cookie('editor'))
            .expect(403)

        mail.fail = false
        const retried = await http()
            .post(`/api/admin/outbox/${id}/retry`)
            .set('Cookie', cookie('admin'))
            .expect(200)
        expect(retried.body).toMatchObject({ status: 'pending', attempts: 0 })

        await worker.wake()
        expect(onlyRow()).toMatchObject({ status: 'sent', attempts: 1 })
        expect(mail.sent).toHaveLength(1)

        await http()
            .post(`/api/admin/outbox/${id}/retry`)
            .set('Cookie', cookie('admin'))
            .expect(409)
        await http()
            .post('/api/admin/outbox/not-an-id/retry')
            .set('Cookie', cookie('admin'))
            .expect(404)
    })

    it('validates the list filters in Spanish', async () => {
        const response = await http()
            .get('/api/admin/outbox?status=lost&pageSize=500')
            .set('Cookie', cookie('admin'))
            .expect(400)
        expect(response.body.details.map((detail: { field: string }) => detail.field)).toEqual([
            'status',
            'pageSize',
        ])
    })
})
