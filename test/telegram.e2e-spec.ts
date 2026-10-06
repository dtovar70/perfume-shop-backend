import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import { Readable } from 'node:stream'
import request from 'supertest'
import { caracasDay } from '../src/common/utils/caracas-date.js'
import { OrderPayment } from '../src/orders/entities/order-payment.entity.js'
import { OrderStatusHistory } from '../src/orders/entities/order-status-history.entity.js'
import { Order } from '../src/orders/entities/order.entity.js'
import { STORAGE_SERVICE, type StorageService } from '../src/storage/storage.service.js'
import { TelegramChat } from '../src/telegram/entities/telegram-chat.entity.js'
import { TelegramMessage } from '../src/telegram/entities/telegram-message.entity.js'
import { FakeDb, PNG, USERS, type Row } from './fixtures/fake-orders-db.js'
import {
    callbackUpdate,
    FakeTelegramDb,
    FakeTelegramServer,
    textUpdate,
} from './fixtures/fake-telegram.js'

const SECRET = 'test-webhook-secret'
const OWNER = 1001
const HELPER = 1002
const STRANGER = 2002

/** Polls until `check` stops throwing (the bot reacts to events asynchronously). */
async function eventually(check: () => void, timeoutMs = 3000): Promise<void> {
    const started = Date.now()
    for (;;) {
        try {
            check()
            return
        } catch (error) {
            if (Date.now() - started > timeoutMs) throw error
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
    }
}

function buttons(markup: unknown): { text: string; callback_data?: string; url?: string }[] {
    const keyboard = (markup as { inline_keyboard?: unknown[][] } | undefined)?.inline_keyboard
    return (keyboard ?? []).flat() as { text: string; callback_data?: string; url?: string }[]
}

describe('Telegram bot (e2e, fake Bot API)', () => {
    const telegramServer = new FakeTelegramServer()
    let app: INestApplication
    let db: FakeDb
    let tg: FakeTelegramDb
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
    const webhook = (update: Row, secret: string | null = SECRET) => {
        const req = http().post('/api/telegram/webhook')
        if (secret !== null) req.set('X-Telegram-Bot-Api-Secret-Token', secret)
        return req.send(update)
    }

    const placeOrder = async () => {
        const response = await http()
            .post('/api/orders')
            .send({
                fullName: 'Ana <b>Pérez</b>',
                email: 'ana@example.com',
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
            })
            .expect(201)
        return response.body as { code: string; accessToken: string }
    }

    const pay = (code: string, token: string, fields: Row = {}, proof = true) => {
        const req = http().post(`/api/orders/${code}/payment?t=${token}`)
        const values: Row = {
            reference: '123456',
            payerBankCode: '0102',
            payerPhone: '0414-1234567',
            paidOn: caracasDay(),
            amountBs: '30760.69',
            ...fields,
        }
        for (const [key, value] of Object.entries(values)) req.field(key, String(value))
        if (proof) req.attach('proof', PNG, { filename: 'pago.png', contentType: 'image/png' })
        return req.expect(200)
    }

    /** Links OWNER with a fresh code; returns the chat row. */
    const link = async (chatId = OWNER) => {
        const { body } = await http()
            .post('/api/admin/telegram/link-codes')
            .set('Cookie', cookie('admin'))
            .expect(201)
        await webhook(textUpdate(chatId, `/start ${body.code as string}`)).expect(200)
        return tg.table(TelegramChat).find((row) => row.chatId === String(chatId))
    }

    /** A paid order whose payment notification reached the linked chats. */
    const pendingPayment = async (fields: Row = {}) => {
        const order = await placeOrder()
        await pay(order.code, order.accessToken, fields)
        const payment = db.table(OrderPayment).at(-1) as Row
        await eventually(() =>
            expect(tg.table(TelegramMessage).some((row) => row.paymentId === payment.id)).toBe(
                true,
            ),
        )
        return { ...order, paymentId: payment.id as string }
    }

    const orderRow = (code: string) => db.table(Order).find((row) => row.code === code) as Row

    beforeAll(async () => {
        await telegramServer.start()
        Object.assign(process.env, {
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN',
            TELEGRAM_MODE: 'webhook',
            TELEGRAM_WEBHOOK_SECRET: SECRET,
            TELEGRAM_API_ROOT: telegramServer.url,
            PUBLIC_SITE_URL: 'https://kaizen.test',
            PUBLIC_API_URL: 'https://api.kaizen.test',
        })
    })

    afterAll(async () => {
        await telegramServer.stop()
    })

    beforeEach(async () => {
        db = new FakeDb()
        tg = new FakeTelegramDb()
        tg.attach(db)
        telegramServer.reset()
        telegramServer.blockedChats.clear()
        vi.clearAllMocks()
        storage.readPrivate.mockImplementation(() =>
            Promise.resolve({
                kind: 'stream',
                stream: Readable.from([PNG]),
                contentType: 'image/png',
                size: PNG.length,
            }),
        )
        // Imported here: the configuration is read when the module is loaded.
        const { AppModule } = await import('../src/app.module.js')
        const { createValidationPipe } = await import('../src/common/pipes/validation.pipe.js')
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
        app.enableShutdownHooks()
        await app.init()

        const signer = new JwtService({ secret: app.get(ConfigService).get<string>('JWT_SECRET') })
        cookie = (user) =>
            `kz_session=${signer.sign({ sub: USERS[user].id, role: USERS[user].role }, { expiresIn: 600 })}`
        // The bot connects in the background (getMe, commands, setWebhook).
        await eventually(() => expect(telegramServer.of('setWebhook')).toHaveLength(1))
    })

    afterEach(async () => {
        await app.close()
    })

    it('connects in webhook mode and reports its status to ADMIN only', async () => {
        expect(telegramServer.of('setWebhook')[0]).toMatchObject({
            url: 'https://api.kaizen.test/api/telegram/webhook',
            secret_token: SECRET,
            allowed_updates: ['message', 'callback_query'],
        })
        expect(telegramServer.of('setMyCommands')[0]?.commands).toEqual(
            expect.arrayContaining([expect.objectContaining({ command: 'pendientes' })]),
        )
        const { body } = await http()
            .get('/api/admin/telegram')
            .set('Cookie', cookie('admin'))
            .expect(200)
        expect(body).toEqual({
            bot: {
                enabled: true,
                mode: 'webhook',
                connected: true,
                username: 'kaizen_test_bot',
                name: 'Manada Test',
                error: null,
            },
            chats: [],
        })
        await http().get('/api/admin/telegram').set('Cookie', cookie('editor')).expect(403)
        await http().get('/api/admin/telegram').expect(401)
    })

    it('rejects webhook calls without the secret', async () => {
        await webhook(textUpdate(STRANGER, '/start'), null).expect(401)
        await webhook(textUpdate(STRANGER, '/start'), 'wrong').expect(401)
        await webhook({ nope: true }).expect(400)
        expect(telegramServer.of('sendMessage')).toHaveLength(0)
    })

    it('links a chat with a one-time code and refuses everyone else', async () => {
        await webhook(textUpdate(STRANGER, '/start')).expect(200)
        await webhook(textUpdate(STRANGER, '/pendientes')).expect(200)
        await webhook(textUpdate(STRANGER, '/start 000000')).expect(200)
        await webhook(callbackUpdate(STRANGER, 'ux:y')).expect(200)
        const replies = telegramServer.of('sendMessage').map((call) => call.text as string)
        expect(replies[0]).toContain('bot privado')
        expect(replies[1]).toContain('bot privado')
        expect(replies[2]).toContain('no es válido o ya venció')
        expect(telegramServer.of('answerCallbackQuery')[0]).toMatchObject({ show_alert: true })

        const { body: issued } = await http()
            .post('/api/admin/telegram/link-codes')
            .set('Cookie', cookie('admin'))
            .expect(201)
        expect(issued).toMatchObject({
            code: expect.stringMatching(/^\d{6}$/),
            expiresInSeconds: 600,
            botUsername: 'kaizen_test_bot',
            deepLink: `https://t.me/kaizen_test_bot?start=${issued.code as string}`,
        })
        await webhook(textUpdate(OWNER, `/start ${issued.code as string}`)).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('quedó vinculado')
        expect(tg.table(TelegramChat)).toEqual([
            expect.objectContaining({
                chatId: String(OWNER),
                firstName: 'Dueña',
                username: 'duena',
                linkedByUserId: USERS.admin.id,
                isActive: true,
                notifyNewOrders: false,
            }),
        ])
        // Single use: a second chat cannot reuse it.
        await webhook(textUpdate(HELPER, `/start ${issued.code as string}`)).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('no es válido')
        expect(tg.table(TelegramChat)).toHaveLength(1)

        const { body } = await http()
            .get('/api/admin/telegram')
            .set('Cookie', cookie('admin'))
            .expect(200)
        expect(body.chats).toEqual([
            expect.objectContaining({
                chatId: String(OWNER),
                linkedBy: { id: USERS.admin.id, name: USERS.admin.name, isActive: true },
            }),
        ])
    })

    it('sends the payment with the private proof, flags and buttons to every linked chat', async () => {
        await link(OWNER)
        await link(HELPER)
        const order = await placeOrder()
        await pay(order.code, order.accessToken, { amountBs: '30000' })
        const payment = db.table(OrderPayment)[0] as Row

        await eventually(() => expect(telegramServer.of('sendPhoto')).toHaveLength(2))
        const [first, second] = telegramServer.of('sendPhoto')
        // Uploaded once from the private storage, then reused by file id.
        expect(storage.readPrivate).toHaveBeenCalledWith('payment-proofs/proof.png')
        expect(first?.photoBytes).toEqual(PNG)
        expect(second?.photo).toBe('photo-file-1')
        const caption = first?.caption as string
        expect(caption).toContain('Nuevo pago por verificar')
        expect(caption).toContain(order.code)
        // Customer text is escaped.
        expect(caption).toContain('Ana &lt;b&gt;Pérez&lt;/b&gt;')
        expect(caption).toContain('2 × Lattafa Khamrah (15 oz)')
        expect(caption).toContain('$36,00 · Bs. 30.760,69')
        expect(caption).toContain('<code>123456</code>')
        expect(caption).toContain('Monto pagado: <b>Bs. 30.000,00</b>')
        expect(caption).toContain('Monto no coincide:</b> faltan Bs. 760,69')
        expect(caption).toContain('Enviado por el cliente')
        expect(first?.parse_mode).toBe('HTML')
        expect(buttons(first?.reply_markup)).toEqual([
            { text: '✅ Pago recibido', callback_data: `pv:${payment.id as string}` },
            { text: '❌ Rechazar', callback_data: `pr:${payment.id as string}` },
            {
                text: '🔗 Ver en el panel',
                url: `https://kaizen.test/admin/pedidos/${order.code}`,
            },
        ])
        await eventually(() =>
            expect(tg.table(TelegramMessage)).toEqual([
                expect.objectContaining({ chatId: String(OWNER), kind: 'payment_caption' }),
                expect.objectContaining({ chatId: String(HELPER), kind: 'payment_caption' }),
            ]),
        )
    })

    it('deactivates a chat that blocked the bot without affecting the others', async () => {
        await link(OWNER)
        await link(HELPER)
        telegramServer.blockedChats.add(String(HELPER))
        await pendingPayment()
        await eventually(() =>
            expect(
                tg.table(TelegramChat).find((row) => row.chatId === String(HELPER))?.isActive,
            ).toBe(false),
        )
        expect(tg.table(TelegramMessage).map((row) => row.chatId)).toEqual([String(OWNER)])
    })

    it('confirms from Telegram once, edits every copy and ignores double taps', async () => {
        await link(OWNER)
        await link(HELPER)
        const { code, paymentId } = await pendingPayment()
        telegramServer.reset()

        await webhook(callbackUpdate(OWNER, `pv:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PAGO_VERIFICADO')
        const history = db.table(OrderStatusHistory).at(-1)
        expect(history).toMatchObject({
            toStatus: 'PAGO_VERIFICADO',
            actorType: 'telegram',
            actorUserId: USERS.admin.id,
            note: 'Confirmado desde Telegram por Dueña.',
        })
        const edits = telegramServer.of('editMessageCaption')
        expect(edits.map((edit) => String(edit.chat_id))).toEqual([String(OWNER), String(HELPER)])
        for (const edit of edits) {
            expect(edit.caption).toContain('Pago confirmado</b> por Dueña')
            expect(buttons(edit.reply_markup).some((button) => button.callback_data)).toBe(false)
        }
        expect(telegramServer.of('answerCallbackQuery').at(-1)?.text).toContain('Pago confirmado')

        // The other chat taps its stale button: nothing moves twice.
        const historyCount = db.table(OrderStatusHistory).length
        await webhook(callbackUpdate(HELPER, `pv:${paymentId}`)).expect(200)
        expect(db.table(OrderStatusHistory)).toHaveLength(historyCount)
        expect(telegramServer.of('answerCallbackQuery').at(-1)?.text).toBe(
            'Este pago ya fue procesado: Pago verificado',
        )
    })

    it('asks a second confirmation when stock is missing', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()
        orderRow(code).stockConflict = {
            detectedAt: new Date().toISOString(),
            lines: [
                {
                    productId: 'mug-001',
                    productName: 'Lattafa Khamrah',
                    requested: 2,
                    available: 0,
                    reserved: 0,
                },
            ],
            resolvedAt: null,
            resolvedById: null,
        }
        telegramServer.reset()

        await webhook(callbackUpdate(OWNER, `pv:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PENDIENTE_VERIFICACION')
        const prompt = telegramServer.of('sendMessage').at(-1)
        expect(prompt?.text).toContain('Falta stock')
        expect(prompt?.text).toContain('«Lattafa Khamrah» pidió 2, hay 0')
        expect(buttons(prompt?.reply_markup)[0]).toEqual({
            text: '✅ Confirmar igual (falta stock)',
            callback_data: `pa:${paymentId}`,
        })

        await webhook(callbackUpdate(OWNER, `pa:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PAGO_VERIFICADO')
        expect((orderRow(code).stockConflict as Row).resolvedAt).toBeTruthy()
        // The question is gone.
        expect(telegramServer.of('deleteMessage')).toHaveLength(1)
    })

    const variantConflict = (code: string) => {
        orderRow(code).stockConflict = {
            detectedAt: new Date().toISOString(),
            lines: [
                {
                    productId: 'mug-001',
                    variantId: 'v-15oz',
                    productName: 'Lattafa Khamrah',
                    variantLabel: '15 oz',
                    requested: 2,
                    available: 0,
                    reserved: 0,
                },
            ],
            resolvedAt: null,
            resolvedById: null,
        }
    }

    it('confirms right away when the missing stock is back', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()
        // Recorded with 0 in stock; the variant has 3 now.
        variantConflict(code)
        telegramServer.reset()

        await webhook(callbackUpdate(OWNER, `pv:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PAGO_VERIFICADO')
        expect(telegramServer.of('sendMessage')).toHaveLength(0)
        expect((orderRow(code).stockConflict as Row).resolvedAt).toBeTruthy()
        expect(db.variantStock('v-15oz')).toBe(1)
        expect(telegramServer.of('answerCallbackQuery').at(-1)?.text).toContain('Pago confirmado')
    })

    it('asks with the current stock when it is still short', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()
        variantConflict(code)
        db.setVariantStock('v-15oz', 1)
        telegramServer.reset()

        await webhook(callbackUpdate(OWNER, `pv:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PENDIENTE_VERIFICACION')
        const prompt = telegramServer.of('sendMessage').at(-1)
        expect(prompt?.text).toContain('«Lattafa Khamrah – 15 oz» pidió 2, hay 1')

        await webhook(callbackUpdate(OWNER, `pa:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PAGO_VERIFICADO')
        expect(db.variantStock('v-15oz')).toBe(0)
    })

    it('rejects with a quick reason and offers the WhatsApp reminder', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()
        telegramServer.reset()

        await webhook(callbackUpdate(OWNER, `pr:${paymentId}`)).expect(200)
        const prompt = telegramServer.of('sendMessage').at(-1)
        expect(buttons(prompt?.reply_markup).map((button) => button.text)).toEqual([
            'Monto incompleto',
            'No encontramos el pago',
            'Referencia inválida',
            '✍️ Otro motivo…',
            'Cancelar',
        ])

        await webhook(callbackUpdate(OWNER, `rq:1:${paymentId}`)).expect(200)
        expect(orderRow(code).status).toBe('PAGO_RECHAZADO')
        expect(db.table(OrderPayment)[0]).toMatchObject({
            status: 'RECHAZADO',
            rejectionReason: 'No encontramos el pago',
            reviewedById: USERS.admin.id,
        })
        const edit = telegramServer.of('editMessageCaption').at(-1)
        expect(edit?.caption).toContain('Pago rechazado</b> por Dueña')
        expect(edit?.caption).toContain('Motivo: No encontramos el pago')
        expect(buttons(edit?.reply_markup)[0]).toMatchObject({
            text: '💬 Avisar al cliente por WhatsApp',
            url: expect.stringMatching(/^https:\/\/wa\.me\/584141234567\?text=/),
        })
        expect(telegramServer.of('deleteMessage')).toHaveLength(1)
    })

    it('takes a typed reason through ForceReply, and Cancelar aborts', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()

        await webhook(callbackUpdate(OWNER, `pr:${paymentId}`)).expect(200)
        await webhook(callbackUpdate(OWNER, `pc:${paymentId}`)).expect(200)
        expect(telegramServer.of('answerCallbackQuery').at(-1)?.text).toContain('no hice nada')

        await webhook(callbackUpdate(OWNER, `pr:${paymentId}`)).expect(200)
        await webhook(callbackUpdate(OWNER, `ro:${paymentId}`)).expect(200)
        const question = telegramServer.of('sendMessage').at(-1)
        expect(question?.text).toContain('Escribe el motivo del rechazo')
        expect(question?.reply_markup).toMatchObject({ force_reply: true })

        await webhook(textUpdate(OWNER, 'x'.repeat(501))).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('muy largo')
        expect(orderRow(code).status).toBe('PENDIENTE_VERIFICACION')

        await webhook(textUpdate(OWNER, 'El capture <no> se ve')).expect(200)
        expect(orderRow(code).status).toBe('PAGO_RECHAZADO')
        expect((db.table(OrderPayment)[0] as Row).rejectionReason).toBe('El capture <no> se ve')
        expect(telegramServer.of('editMessageCaption').at(-1)?.caption).toContain(
            'Motivo: El capture &lt;no&gt; se ve',
        )
    })

    it('updates the Telegram copies when the payment is confirmed on the web', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()
        telegramServer.reset()

        await http()
            .post(`/api/admin/orders/${code}/transitions`)
            .set('Cookie', cookie('admin'))
            .send({ to: 'PAGO_VERIFICADO' })
            .expect(200)
        await eventually(() => expect(telegramServer.of('editMessageCaption')).toHaveLength(1))
        const edit = telegramServer.of('editMessageCaption')[0]
        expect(edit?.caption).toContain(
            `Pago confirmado</b> por ${USERS.admin.name} desde el panel`,
        )
        expect(buttons(edit?.reply_markup).some((button) => button.callback_data)).toBe(false)
        expect(tg.table(TelegramMessage)[0]?.resolution).toContain('desde el panel')

        // A stale tap afterwards only refreshes.
        await webhook(callbackUpdate(OWNER, `pr:${paymentId}`)).expect(200)
        expect(telegramServer.of('answerCallbackQuery').at(-1)?.text).toBe(
            'Este pago ya fue procesado: Pago verificado',
        )
    })

    it('answers /pendientes, /pedido, /ayuda and /salir', async () => {
        await link(OWNER)
        const { code, paymentId } = await pendingPayment()
        telegramServer.reset()

        await webhook(textUpdate(OWNER, '/pendientes')).expect(200)
        const [intro, listed] = telegramServer.of('sendMessage')
        expect(intro?.text).toBe('🧾 Hay 1 pago por verificar:')
        expect(listed?.text).toContain(code)
        expect(buttons(listed?.reply_markup)[0]?.callback_data).toBe(`pv:${paymentId}`)

        await webhook(textUpdate(OWNER, '/pedido 1')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('Nuevo pago por verificar')
        await webhook(textUpdate(OWNER, '/pedido KZ-999999')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('No encontré el pedido')
        await webhook(textUpdate(OWNER, '/ayuda')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('/pendientes')

        await webhook(textUpdate(OWNER, '/salir')).expect(200)
        expect(buttons(telegramServer.of('sendMessage').at(-1)?.reply_markup)[0]).toEqual({
            text: 'Sí, desvincular',
            callback_data: 'ux:y',
        })
        await webhook(callbackUpdate(OWNER, 'ux:y')).expect(200)
        expect(tg.table(TelegramChat)).toHaveLength(0)
        expect(tg.table(TelegramMessage)).toHaveLength(0)
        await webhook(textUpdate(OWNER, '/pendientes')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('bot privado')
    })

    it('answers /micuenta with the linked panel account, and nothing to unlinked chats', async () => {
        expect(telegramServer.of('setMyCommands')[0]?.commands).toEqual(
            expect.arrayContaining([expect.objectContaining({ command: 'micuenta' })]),
        )
        await webhook(textUpdate(STRANGER, '/micuenta')).expect(200)
        const refused = telegramServer.of('sendMessage').at(-1)?.text as string
        expect(refused).toContain('bot privado')
        expect(refused).not.toContain('@example.com')

        await link()
        await webhook(textUpdate(OWNER, '/micuenta')).expect(200)
        const reply = telegramServer.of('sendMessage').at(-1)
        expect(reply?.parse_mode).toBe('HTML')
        expect(reply?.text).toContain('Nombre: Dueña')
        expect(reply?.text).toContain(`Correo: ${USERS.admin.id}@example.com`)
        expect(reply?.text).toContain('Rol: Administrador')
        expect(reply?.text).toContain('Estado: Activa')

        await webhook(textUpdate(OWNER, '/ayuda')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('/micuenta')

        // Linked by an account that was deactivated: treated as unlinked.
        tg.inactiveUsers.add(USERS.admin.id)
        await webhook(textUpdate(OWNER, '/micuenta')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('bot privado')
    })

    it('notifies new orders only to the chats that asked for them', async () => {
        const owner = await link(OWNER)
        await link(HELPER)
        await http()
            .patch(`/api/admin/telegram/chats/${owner?.id as string}`)
            .set('Cookie', cookie('admin'))
            .send({ notifyNewOrders: true })
            .expect(200)
            .expect((res) => expect(res.body.notifyNewOrders).toBe(true))
        telegramServer.reset()

        const order = await placeOrder()
        await eventually(() => expect(telegramServer.of('sendMessage')).toHaveLength(1))
        const notice = telegramServer.of('sendMessage')[0]
        expect(String(notice?.chat_id)).toBe(String(OWNER))
        expect(notice?.text).toContain(`Nuevo pedido</b> · <b>${order.code}`)
    })

    it('sends a test message and unlinks from the admin', async () => {
        const owner = await link(OWNER)
        const id = owner?.id as string
        telegramServer.reset()
        await http()
            .post(`/api/admin/telegram/chats/${id}/test`)
            .set('Cookie', cookie('admin'))
            .expect(200, { ok: true })
        expect(telegramServer.of('sendMessage')[0]?.text).toContain('mensaje de prueba')

        telegramServer.blockedChats.add(String(OWNER))
        await http()
            .post(`/api/admin/telegram/chats/${id}/test`)
            .set('Cookie', cookie('admin'))
            .expect(502)
        expect(tg.table(TelegramChat)[0]?.isActive).toBe(false)

        await http()
            .patch(`/api/admin/telegram/chats/${id}`)
            .set('Cookie', cookie('admin'))
            .send({ notifyNewOrders: 'sí' })
            .expect(400)
        await http()
            .delete(`/api/admin/telegram/chats/${id}`)
            .set('Cookie', cookie('admin'))
            .expect(204)
        expect(tg.table(TelegramChat)).toHaveLength(0)
        await http()
            .delete(`/api/admin/telegram/chats/${id}`)
            .set('Cookie', cookie('admin'))
            .expect(404)
    })

    describe('contact form', () => {
        const form = (overrides: Row = {}) => ({
            fullName: 'Ana <b>Pérez</b>',
            email: 'ana@example.com',
            phone: '0414-1234567',
            topic: 'mayoreo',
            message: 'Quiero 20 tazas & <franelas> para mi equipo.',
            ...overrides,
        })
        const send = (body: Row) => http().post('/api/contact').send(body)

        it('refuses with 503 while no chat is linked', async () => {
            const { body } = await send(form()).expect(503)
            expect(body.code).toBe('CONTACT_UNAVAILABLE')
            expect(telegramServer.of('sendMessage')).toHaveLength(0)
        })

        it('sends the message to every active chat with a WhatsApp button', async () => {
            await link(OWNER)
            await link(HELPER)
            telegramServer.reset()

            await send(form())
                .expect(202)
                .expect({ message: 'Recibimos tu mensaje. Te respondemos pronto.' })
            await eventually(() => expect(telegramServer.of('sendMessage')).toHaveLength(2))
            const [first, second] = telegramServer.of('sendMessage')
            expect([String(first?.chat_id), String(second?.chat_id)].sort()).toEqual(
                [String(OWNER), String(HELPER)].sort(),
            )
            const text = first?.text as string
            expect(text).toContain('📨 <b>Nuevo mensaje de contacto</b>')
            expect(text).toContain('👤 Ana &lt;b&gt;Pérez&lt;/b&gt;')
            expect(text).toContain('✉️ ana@example.com')
            expect(text).toContain('📱 WhatsApp: 0414-1234567')
            expect(text).toContain('🏷️ Pedido por mayor')
            expect(text).toContain('Quiero 20 tazas &amp; &lt;franelas&gt; para mi equipo.')
            expect(first?.parse_mode).toBe('HTML')
            const [button] = buttons(first?.reply_markup)
            expect(button?.text).toBe('💬 Abrir WhatsApp')
            expect(button?.url).toMatch(/^https:\/\/wa\.me\/584141234567\?text=Hola%20Ana%2C/)
        })

        it('omits the WhatsApp line and button without a phone', async () => {
            await link(OWNER)
            telegramServer.reset()
            await send(form({ phone: '' })).expect(202)
            await eventually(() => expect(telegramServer.of('sendMessage')).toHaveLength(1))
            const notice = telegramServer.of('sendMessage')[0]
            expect(notice?.text).not.toContain('WhatsApp')
            expect(buttons(notice?.reply_markup)).toEqual([])
        })

        it('limits each email to 3 messages every 15 minutes', async () => {
            await link(OWNER)
            for (let i = 0; i < 3; i++) await send(form({ email: 'Ana@Example.com' })).expect(202)
            const { body } = await send(form()).expect(429)
            expect(body.message).toContain('Espera unos minutos')
            await send(form({ email: 'otra@example.com' })).expect(202)
        })
    })

    it('treats a chat linked by a deactivated user as unlinked until it is linked again', async () => {
        const owner = await link(OWNER)
        const id = owner?.id as string
        // What deactivating the user does (see the admin users e2e): the chat is switched off.
        tg.inactiveUsers.add(USERS.admin.id)
        tg.table(TelegramChat)[0]!.isActive = false
        telegramServer.reset()

        await webhook(textUpdate(OWNER, '/pendientes')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).toContain('bot privado')
        // Writing to the bot does not bring it back.
        expect(tg.table(TelegramChat)[0]?.isActive).toBe(false)

        const { body } = await http()
            .get('/api/admin/telegram')
            .set('Cookie', cookie('admin'))
            .expect(200)
        expect(body.chats[0].linkedBy).toMatchObject({ isActive: false })
        await http()
            .post(`/api/admin/telegram/chats/${id}/test`)
            .set('Cookie', cookie('admin'))
            .expect(409)

        // Linked again by an active admin: works as usual.
        tg.inactiveUsers.clear()
        await link(OWNER)
        expect(tg.table(TelegramChat)[0]?.isActive).toBe(true)
        telegramServer.reset()
        await webhook(textUpdate(OWNER, '/ayuda')).expect(200)
        expect(telegramServer.of('sendMessage').at(-1)?.text).not.toContain('bot privado')
    })
})
