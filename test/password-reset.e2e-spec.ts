import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import argon2 from 'argon2'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { PasswordResetCode } from '../src/auth/entities/password-reset-code.entity.js'
import { User } from '../src/auth/entities/user.entity.js'
import type { PasswordResetService as PasswordResetServiceType } from '../src/auth/password-reset/password-reset.service.js'
import { Role } from '../src/auth/role.enum.js'
import { MAIL_TRANSPORT, type MailTransport, type OutgoingMail } from '../src/mail/mail.types.js'
import { TelegramChat } from '../src/telegram/entities/telegram-chat.entity.js'
import { FakeTelegramServer } from './fixtures/fake-telegram.js'
import { FakeUsersDb, type Row } from './fixtures/fake-users-db.js'

const OWNER = { id: 'owner-1', email: 'duena@example.com', password: 'Clave-dueña-2026' }
const NO_CHAT = { id: 'editor-1', email: 'editor@example.com', password: 'Clave-editor-2026' }
const INACTIVE = { id: 'former-1', email: 'antes@example.com', password: 'Clave-antes-2026' }
const OWNER_CHAT = 1001
const OWNER_MUTED_CHAT = 1004
const INACTIVE_CHAT = 1003
const NEW_PASSWORD = 'Nueva-clave-2026'

const REQUESTED = {
    message:
        'Si el correo pertenece a una cuenta activa, te enviamos un código de 6 dígitos por Telegram (si lo tienes vinculado) o a tu correo. Vence en 10 minutos.',
}
const INVALID_CODE = 'Código inválido o vencido.'

let hashes: Record<string, string>

/** Catches emails. Off by default (like MAIL_DRIVER=log): the email channel then reaches no one. */
class FakeMailTransport implements MailTransport {
    readonly driver = 'smtp' as const
    delivers = false
    sent: OutgoingMail[] = []

    send(message: OutgoingMail): Promise<void> {
        this.sent.push(message)
        return Promise.resolve()
    }
}

function seed(db: FakeUsersDb): void {
    const created = new Date('2026-01-01T00:00:00Z')
    const user = (account: typeof OWNER, name: string, role: Role, isActive = true): Row => ({
        id: account.id,
        email: account.email,
        name,
        role,
        passwordHash: hashes[account.id],
        isActive,
        passwordChangedAt: null,
        lastLoginAt: null,
        createdAt: created,
        updatedAt: created,
    })
    db.table(User).push(
        user(OWNER, 'Dueña', Role.ADMIN),
        user(NO_CHAT, 'Editor', Role.EDITOR),
        user(INACTIVE, 'Antes', Role.EDITOR, false),
    )
    const chat = (chatId: number, linkedByUserId: string, isActive = true): Row => ({
        id: `chat-${chatId}`,
        chatId: String(chatId),
        username: null,
        firstName: null,
        linkedByUserId,
        isActive,
        notifyNewOrders: false,
        linkedAt: created,
        lastSeenAt: null,
    })
    db.table(TelegramChat).push(
        chat(OWNER_CHAT, OWNER.id),
        // Blocked the bot (inactive): gets nothing.
        chat(OWNER_MUTED_CHAT, OWNER.id, false),
        chat(INACTIVE_CHAT, INACTIVE.id),
    )
}

/**
 * Admin password recovery through the Telegram bot (and email as the fallback): the real app (guards, throttler,
 * validation, argon2, grammY) with the database in memory and a fake Bot API.
 */
describe('Password reset by Telegram (e2e, fake Bot API)', () => {
    const telegramServer = new FakeTelegramServer()
    let app: INestApplication
    let db: FakeUsersDb
    let resets: PasswordResetServiceType
    let mail: FakeMailTransport

    const http = () => request(app.getHttpServer())
    const requestCode = (email: string) =>
        http().post('/api/auth/password-reset/request').send({ email })
    const confirm = (email: string, code: string, newPassword = NEW_PASSWORD) =>
        http().post('/api/auth/password-reset/confirm').send({ email, code, newPassword })
    const login = (email: string, password: string) =>
        http().post('/api/auth/login').send({ email, password })

    const sessionCookie = (header: unknown): string => {
        const cookies = ([] as string[]).concat((header as string[] | string | undefined) ?? [])
        const session = cookies.find((cookie) => cookie.startsWith('kz_session='))
        if (!session) throw new Error('No session cookie')
        return session.split(';')[0] as string
    }

    const sent = () => telegramServer.of('sendMessage')

    /** Requests a code for OWNER and returns what the fake bot received. */
    const ownerCode = async (): Promise<string> => {
        const before = sent().length
        await requestCode(OWNER.email).expect(202)
        await resets.idle()
        const message = sent().slice(before).at(-1)?.text as string
        const code = /<b>(\d{6})<\/b>/.exec(message)?.[1]
        if (!code) throw new Error(`No code in ${message}`)
        return code
    }

    const codes = () => db.table(PasswordResetCode)

    beforeAll(async () => {
        await telegramServer.start()
        Object.assign(process.env, {
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN',
            TELEGRAM_MODE: 'webhook',
            TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
            TELEGRAM_API_ROOT: telegramServer.url,
        })
        hashes = {
            [OWNER.id]: await argon2.hash(OWNER.password),
            [NO_CHAT.id]: await argon2.hash(NO_CHAT.password),
            [INACTIVE.id]: await argon2.hash(INACTIVE.password),
        }
    })

    afterAll(async () => {
        await telegramServer.stop()
    })

    beforeEach(async () => {
        db = new FakeUsersDb()
        seed(db)
        telegramServer.reset()
        mail = new FakeMailTransport()
        // Imported here: the configuration is read when the module is loaded.
        const { AppModule } = await import('../src/app.module.js')
        const { createValidationPipe } = await import('../src/common/pipes/validation.pipe.js')
        const { PasswordResetService } =
            await import('../src/auth/password-reset/password-reset.service.js')
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(db.dataSource)
            .overrideProvider(MAIL_TRANSPORT)
            .useValue(mail)
            .compile()
        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.use(cookieParser())
        app.useGlobalPipes(createValidationPipe())
        app.enableShutdownHooks()
        await app.init()
        resets = app.get(PasswordResetService)
        // The bot connects in the background (getMe, commands, setWebhook).
        for (let tries = 0; !telegramServer.of('setWebhook').length && tries < 150; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
        telegramServer.reset()
    })

    afterEach(async () => {
        await app.close()
    })

    it('answers the same for a user with a chat and an unknown email; only that chat gets a code', async () => {
        const known = await requestCode(`  ${OWNER.email.toUpperCase()} `).expect(202)
        const unknown = await requestCode('nadie@example.com').expect(202)
        expect(known.body).toEqual(REQUESTED)
        expect(unknown.body).toEqual(known.body)
        await resets.idle()

        expect(sent()).toHaveLength(1)
        const message = sent()[0] as Row
        expect(message.chat_id).toBe(String(OWNER_CHAT))
        expect(message.parse_mode).toBe('HTML')
        expect(message.protect_content).toBe(true)
        expect(message.text).toMatch(
            /^🔐 Código para restablecer tu contraseña de KaiZen: <b>\d{6}<\/b>\nVence en 10 minutos\. Si no fuiste tú, ignora este mensaje y avísale a un administrador\.$/,
        )

        expect(codes()).toHaveLength(1)
        const row = codes()[0] as Row
        const code = /<b>(\d{6})<\/b>/.exec(message.text as string)?.[1] as string
        expect(row).toMatchObject({ userId: OWNER.id, channel: 'telegram', attempts: 0 })
        expect(row.usedAt).toBeNull()
        expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/)
        expect(row.codeHash).not.toContain(code)
        expect(typeof row.requesterIp).toBe('string')
        const ttl = (row.expiresAt as Date).getTime() - (row.createdAt as Date).getTime()
        expect(ttl).toBe(10 * 60_000)
    })

    it('answers the same for a user without a chat and an inactive user, and sends nothing', async () => {
        const noChat = await requestCode(NO_CHAT.email).expect(202)
        const inactive = await requestCode(INACTIVE.email).expect(202)
        expect(noChat.body).toEqual(REQUESTED)
        expect(inactive.body).toEqual(REQUESTED)
        await resets.idle()
        expect(sent()).toHaveLength(0)
        expect(codes()).toHaveLength(0)
    })

    it('limits requests to 3 per 15 minutes', async () => {
        for (let index = 0; index < 3; index++) await requestCode(OWNER.email).expect(202)
        await requestCode(OWNER.email).expect(429)
        await resets.idle()
    })

    it('resets the password with the right code: old sessions end, Telegram is told, no auto-login', async () => {
        const oldSession = sessionCookie(
            (await login(OWNER.email, OWNER.password).expect(200)).headers['set-cookie'],
        )
        await http().get('/api/auth/me').set('Cookie', oldSession).expect(200)
        const code = await ownerCode()

        // Password policy problems are field errors (checked before the code).
        const weak = await confirm(OWNER.email, code, 'corta').expect(400)
        expect(weak.body.details).toEqual([
            {
                field: 'newPassword',
                errors: expect.arrayContaining([
                    'La nueva contraseña debe tener al menos 10 caracteres.',
                    'La nueva contraseña debe incluir al menos un número.',
                ]) as unknown,
            },
        ])
        expect((codes()[0] as Row).attempts).toBe(0)

        const done = await confirm(OWNER.email, code).expect(204)
        expect(done.headers['set-cookie']).toBeUndefined()
        expect((codes()[0] as Row).usedAt).toBeInstanceOf(Date)
        expect(db.user(OWNER.id).passwordChangedAt).toBeInstanceOf(Date)

        // Tokens are dated in whole seconds; the change is stamped at the next second.
        const unauthorized = await http().get('/api/auth/me').set('Cookie', oldSession).expect(401)
        expect(unauthorized.body.message).toContain('Tu contraseña cambió')
        await login(OWNER.email, OWNER.password).expect(401)
        await login(OWNER.email, NEW_PASSWORD).expect(200)

        expect(sent().at(-1)).toMatchObject({
            chat_id: String(OWNER_CHAT),
            text: '✅ Tu contraseña se cambió. Si no fuiste tú, contacta a un administrador.',
        })

        // A used code never works again.
        const reused = await confirm(OWNER.email, code, 'Otra-clave-2026').expect(400)
        expect(reused.body.message).toBe(INVALID_CODE)
        expect(reused.body.details).toEqual([{ field: 'code', errors: [INVALID_CODE] }])
    })

    it('burns a code after 5 wrong attempts', async () => {
        const code = await ownerCode()
        const wrong = code === '000000' ? '111111' : '000000'
        for (let attempt = 0; attempt < 5; attempt++) {
            const response = await confirm(OWNER.email, wrong).expect(400)
            expect(response.body.message).toBe(INVALID_CODE)
        }
        expect((codes()[0] as Row).attempts).toBe(5)
        const late = await confirm(OWNER.email, code).expect(400)
        expect(late.body.message).toBe(INVALID_CODE)
        expect((codes()[0] as Row).usedAt).toBeNull()
        await login(OWNER.email, OWNER.password).expect(200)
    })

    it('rejects an expired code, a code from an older request and unknown emails alike', async () => {
        const first = await ownerCode()
        const second = await ownerCode()
        // Asking again invalidated the first code.
        if (first !== second) {
            expect((await confirm(OWNER.email, first).expect(400)).body.message).toBe(INVALID_CODE)
        }
        expect((await confirm('nadie@example.com', second).expect(400)).body.message).toBe(
            INVALID_CODE,
        )
        expect((await confirm(OWNER.email, 'abc').expect(400)).body.message).toBe(INVALID_CODE)

        // Ten minutes later.
        for (const row of codes()) row.expiresAt = new Date(Date.now() - 1000)
        expect((await confirm(OWNER.email, second).expect(400)).body.message).toBe(INVALID_CODE)
        await login(OWNER.email, OWNER.password).expect(200)
    })

    describe('by email (the fallback after Telegram)', () => {
        beforeEach(() => {
            mail.delivers = true
        })

        const emailCode = (message: OutgoingMail | undefined): string => {
            const code = /Código: (\d{6})/.exec(message?.text ?? '')?.[1]
            if (!code) throw new Error('No code in the email')
            return code
        }

        it('sends the code by email to a user without a chat, with the same answer', async () => {
            const response = await requestCode(NO_CHAT.email.toUpperCase()).expect(202)
            expect(response.body).toEqual(REQUESTED)
            await resets.idle()

            expect(sent()).toHaveLength(0)
            expect(mail.sent).toHaveLength(1)
            const message = mail.sent[0] as OutgoingMail
            expect(message.to).toBe(NO_CHAT.email)
            expect(message.subject).toBe('Tu código para restablecer la contraseña')
            expect(message.text).toContain('Vence en 10 minutos')
            expect(codes()[0]).toMatchObject({ userId: NO_CHAT.id, channel: 'email' })

            await confirm(NO_CHAT.email, emailCode(message)).expect(204)
            await login(NO_CHAT.email, NEW_PASSWORD).expect(200)
            expect(mail.sent.at(-1)).toMatchObject({
                to: NO_CHAT.email,
                subject: 'Tu contraseña se cambió',
            })
        })

        it('keeps Telegram first for a user with a chat', async () => {
            await ownerCode()
            expect(mail.sent).toHaveLength(0)
            expect(codes()[0]).toMatchObject({ userId: OWNER.id, channel: 'telegram' })
        })

        it('never emails an inactive user or an unknown address', async () => {
            await requestCode(INACTIVE.email).expect(202)
            await requestCode('nadie@example.com').expect(202)
            await resets.idle()
            expect(mail.sent).toHaveLength(0)
            expect(codes()).toHaveLength(0)
        })
    })
})
