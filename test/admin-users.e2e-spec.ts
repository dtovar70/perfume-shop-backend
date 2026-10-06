import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import argon2 from 'argon2'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { User } from '../src/auth/entities/user.entity.js'
import { Role } from '../src/auth/role.enum.js'
import type { AuthUser } from '../src/common/types/auth-user.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { TelegramChat } from '../src/telegram/entities/telegram-chat.entity.js'
import { TelegramLinkCode } from '../src/telegram/entities/telegram-link-code.entity.js'
import { AdminUsersService } from '../src/users/admin-users.service.js'
import { FakeUsersDb, type Row } from './fixtures/fake-users-db.js'

const OWNER = { id: 'owner-1', email: 'duena@example.com', password: 'Clave-dueña-2026' }
const EDITOR = { id: 'editor-1', email: 'editor@example.com', password: 'Clave-editor-2026' }
const INVALID_CREDENTIALS = 'Correo o contraseña incorrectos.'

interface FieldError {
    field: string
    errors: string[]
}

let hashes: Record<string, string>

function seed(db: FakeUsersDb): void {
    const created = new Date('2026-01-01T00:00:00Z')
    db.table(User).push(
        {
            id: OWNER.id,
            email: OWNER.email,
            name: 'Dueña',
            role: Role.ADMIN,
            passwordHash: hashes[OWNER.id],
            isActive: true,
            passwordChangedAt: null,
            lastLoginAt: null,
            createdAt: created,
            updatedAt: created,
        },
        {
            id: EDITOR.id,
            email: EDITOR.email,
            name: 'Editor',
            role: Role.EDITOR,
            passwordHash: hashes[EDITOR.id],
            isActive: true,
            passwordChangedAt: null,
            lastLoginAt: null,
            createdAt: created,
            updatedAt: created,
        },
    )
    const chat = (id: string, linkedByUserId: string, isActive = true): Row => ({
        id,
        chatId: id.replace(/\D/g, ''),
        username: null,
        firstName: null,
        linkedByUserId,
        isActive,
        notifyNewOrders: false,
        linkedAt: created,
        lastSeenAt: null,
    })
    db.table(TelegramChat).push(
        chat('chat-101', EDITOR.id),
        chat('chat-102', EDITOR.id),
        chat('chat-103', OWNER.id),
    )
    db.table(TelegramLinkCode).push({
        id: 'code-1',
        codeHash: 'a'.repeat(64),
        createdByUserId: EDITOR.id,
        expiresAt: new Date(Date.now() + 600_000),
        usedAt: null,
        usedByChatId: null,
        createdAt: new Date(),
    })
}

/**
 * Admin user management and the own-account endpoints, through the real global guards,
 * validation and argon2, with the database in memory.
 */
describe('Admin users and own account (e2e)', () => {
    let app: INestApplication
    let db: FakeUsersDb

    const http = () => request(app.getHttpServer())

    /** Logs in and returns the `kz_session` cookie. */
    const login = async (email: string, password: string): Promise<string> => {
        const response = await http().post('/api/auth/login').send({ email, password }).expect(200)
        return sessionCookie(response.headers['set-cookie'])
    }

    const sessionCookie = (header: unknown): string => {
        const cookies = ([] as string[]).concat((header as string[] | string | undefined) ?? [])
        const session = cookies.find((cookie) => cookie.startsWith('kz_session='))
        if (!session) throw new Error('No session cookie')
        return session.split(';')[0] as string
    }

    const createUser = (cookie: string, body: Row) =>
        http().post('/api/admin/users').set('Cookie', cookie).send(body)

    beforeAll(async () => {
        hashes = {
            [OWNER.id]: await argon2.hash(OWNER.password),
            [EDITOR.id]: await argon2.hash(EDITOR.password),
        }
    })

    beforeEach(async () => {
        db = new FakeUsersDb()
        seed(db)
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(db.dataSource)
            .compile()
        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.use(cookieParser())
        app.useGlobalPipes(createValidationPipe())
        await app.init()
    })

    afterEach(async () => {
        await app.close()
    })

    it('is ADMIN only: 401 without a session, 403 for an EDITOR', async () => {
        await http().get('/api/admin/users').expect(401)
        const editor = await login(EDITOR.email, EDITOR.password)
        await http().get('/api/admin/users').set('Cookie', editor).expect(403)
        await createUser(editor, {
            name: 'X',
            email: 'x@example.com',
            role: Role.ADMIN,
            password: 'Clave-segura-99',
        }).expect(403)
        await http()
            .patch(`/api/admin/users/${EDITOR.id}`)
            .set('Cookie', editor)
            .send({ role: Role.ADMIN })
            .expect(403)
    })

    it('lists users with search, pagination, last access and Telegram chats; never hashes', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        const { body, text } = await http()
            .get('/api/admin/users?pageSize=1')
            .set('Cookie', owner)
            .expect(200)
        expect(body).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 })
        expect(body.items).toEqual([
            expect.objectContaining({
                id: OWNER.id,
                name: 'Dueña',
                role: Role.ADMIN,
                isActive: true,
                createdAt: '2026-01-01T00:00:00.000Z',
                lastLoginAt: expect.any(String),
                telegramChatCount: 1,
                activeTelegramChatCount: 1,
            }),
        ])
        expect(text).not.toMatch(/argon2|passwordHash|password_hash/)

        const search = await http()
            .get('/api/admin/users?search=EDIT')
            .set('Cookie', owner)
            .expect(200)
        expect(search.body.items).toEqual([
            expect.objectContaining({
                id: EDITOR.id,
                lastLoginAt: null,
                telegramChatCount: 2,
                activeTelegramChatCount: 2,
            }),
        ])
        const none = await http()
            .get('/api/admin/users?search=%25')
            .set('Cookie', owner)
            .expect(200)
        expect(none.body.total).toBe(0)
    })

    it('creates users with the password policy and case-insensitive unique emails', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        const base = { name: '  Ana  ', email: 'Ana@Example.com', role: Role.EDITOR }

        const cases: [string, string][] = [
            ['Corta1', 'La contraseña debe tener al menos 10 caracteres.'],
            ['sololetrasaqui', 'La contraseña debe incluir al menos un número.'],
            ['1234567890', 'La contraseña debe incluir al menos una letra.'],
            [`a1${'x'.repeat(199)}`, 'La contraseña no puede superar los 200 caracteres.'],
        ]
        for (const [password, message] of cases) {
            const { body } = await createUser(owner, { ...base, password }).expect(400)
            const details = body.details as FieldError[]
            expect(details.find((detail) => detail.field === 'password')?.errors).toContain(message)
        }
        const invalid = await createUser(owner, {
            name: '',
            email: 'no-es-correo',
            role: 'OWNER',
            password: 'Clave-segura-99',
        }).expect(400)
        expect(invalid.body.details).toEqual(
            expect.arrayContaining([
                { field: 'name', errors: ['El nombre es obligatorio.'] },
                expect.objectContaining({ field: 'email' }),
                {
                    field: 'role',
                    errors: ['El rol debe ser Administrador (ADMIN) o Editor (EDITOR).'],
                },
            ]),
        )

        const created = await createUser(owner, {
            ...base,
            password: 'Clave-segura-99',
        }).expect(201)
        expect(created.body).toMatchObject({
            name: 'Ana',
            email: 'ana@example.com',
            role: Role.EDITOR,
            isActive: true,
            lastLoginAt: null,
            telegramChatCount: 0,
        })
        expect(JSON.stringify(created.body)).not.toMatch(/argon2|password_hash|passwordHash/)

        const duplicate = await createUser(owner, {
            ...base,
            email: 'EDITOR@example.com',
            password: 'Clave-segura-99',
        }).expect(409)
        expect(duplicate.body.message).toBe('Ya existe un usuario con ese correo electrónico.')
        await http()
            .patch(`/api/admin/users/${created.body.id as string}`)
            .set('Cookie', owner)
            .send({ email: ' Editor@Example.com ' })
            .expect(409)

        // The new account can log in (any case) and its login is recorded.
        await login('ANA@example.com', 'Clave-segura-99')
        expect(db.user(created.body.id as string).lastLoginAt).toBeInstanceOf(Date)
    })

    it('updates name, email and role', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        const { body } = await http()
            .patch(`/api/admin/users/${EDITOR.id}`)
            .set('Cookie', owner)
            .send({ name: 'Editora', email: 'editora@example.com', role: Role.ADMIN })
            .expect(200)
        expect(body).toMatchObject({
            name: 'Editora',
            email: 'editora@example.com',
            role: Role.ADMIN,
        })
        await http()
            .patch(`/api/admin/users/nope`)
            .set('Cookie', owner)
            .send({ name: 'X' })
            .expect(404)
    })

    it('blocks self-demotion, self-deactivation and self-reset', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        const demote = await http()
            .patch(`/api/admin/users/${OWNER.id}`)
            .set('Cookie', owner)
            .send({ role: Role.EDITOR })
            .expect(409)
        expect(demote.body.message).toContain('No puedes cambiar tu propio rol')
        // Sending the same role (the edit form always does) is not a change.
        await http()
            .patch(`/api/admin/users/${OWNER.id}`)
            .set('Cookie', owner)
            .send({ name: 'Dueña Russo', role: Role.ADMIN })
            .expect(200)

        const deactivate = await http()
            .patch(`/api/admin/users/${OWNER.id}/active`)
            .set('Cookie', owner)
            .send({ isActive: false })
            .expect(409)
        expect(deactivate.body.message).toContain('No puedes desactivar tu propia cuenta')
        await http()
            .post(`/api/admin/users/${OWNER.id}/password`)
            .set('Cookie', owner)
            .send({ password: 'Otra-clave-2026' })
            .expect(409)
        expect(db.user(OWNER.id)).toMatchObject({ role: Role.ADMIN, isActive: true })
    })

    it('always keeps one active ADMIN', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        // With the owner still active, a second admin can be demoted and deactivated.
        for (const body of [{ role: Role.ADMIN }, { role: Role.EDITOR }, { role: Role.ADMIN }]) {
            await http()
                .patch(`/api/admin/users/${EDITOR.id}`)
                .set('Cookie', owner)
                .send(body)
                .expect(200)
        }

        // Two admins acting at once: the other admin deactivated the owner a moment ago, after
        // the owner's request passed the guard. Under the users lock the owner's request sees
        // no other active ADMIN, so it cannot remove the last one.
        db.user(OWNER.id).isActive = false
        const service = app.get(AdminUsersService)
        const actor = { id: OWNER.id, role: Role.ADMIN } as AuthUser
        await expect(service.setActive(EDITOR.id, false, actor)).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining('Debe quedar al menos un administrador activo'),
        })
        await expect(service.update(EDITOR.id, { role: Role.EDITOR }, actor)).rejects.toMatchObject(
            { status: 409 },
        )
        expect(db.user(EDITOR.id)).toMatchObject({ role: Role.ADMIN, isActive: true })
        // Renaming the last admin is fine.
        await expect(service.update(EDITOR.id, { name: 'Jefa' }, actor)).resolves.toMatchObject({
            name: 'Jefa',
        })
    })

    it('deactivating: no login (generic error), 401 for open sessions, Telegram chats off', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        const editor = await login(EDITOR.email, EDITOR.password)
        await http().get('/api/auth/me').set('Cookie', editor).expect(200)

        const { body } = await http()
            .patch(`/api/admin/users/${EDITOR.id}/active`)
            .set('Cookie', owner)
            .send({ isActive: false })
            .expect(200)
        expect(body).toMatchObject({
            isActive: false,
            telegramChatsDeactivated: 2,
            telegramChatCount: 2,
            activeTelegramChatCount: 0,
        })
        // Only the editor's chats; the owner's chat keeps working. Unused codes are burned.
        const chats = db.table(TelegramChat)
        expect(chats.map((chat) => [chat.id, chat.isActive])).toEqual([
            ['chat-101', false],
            ['chat-102', false],
            ['chat-103', true],
        ])
        expect(db.table(TelegramLinkCode)).toHaveLength(0)

        await http().get('/api/auth/me').set('Cookie', editor).expect(401)
        const denied = await http()
            .post('/api/auth/login')
            .send({ email: EDITOR.email, password: EDITOR.password })
            .expect(401)
        const wrong = await http()
            .post('/api/auth/login')
            .send({ email: OWNER.email, password: 'no-es-la-clave-1' })
            .expect(401)
        expect(denied.body.message).toBe(INVALID_CREDENTIALS)
        expect(wrong.body.message).toBe(INVALID_CREDENTIALS)

        // Reactivating restores the login, not the chats.
        await http()
            .patch(`/api/admin/users/${EDITOR.id}/active`)
            .set('Cookie', owner)
            .send({ isActive: true })
            .expect(200)
            .expect((res) => expect(res.body.telegramChatsDeactivated).toBe(0))
        expect(chats.filter((chat) => chat.linkedByUserId === EDITOR.id)).toEqual([
            expect.objectContaining({ isActive: false }),
            expect.objectContaining({ isActive: false }),
        ])
        await login(EDITOR.email, EDITOR.password)
        await http()
            .patch(`/api/admin/users/${EDITOR.id}/active`)
            .set('Cookie', owner)
            .send({})
            .expect(400)
    })

    it('an admin reset closes that user’s sessions; the admin keeps theirs', async () => {
        const owner = await login(OWNER.email, OWNER.password)
        const editor = await login(EDITOR.email, EDITOR.password)

        await http()
            .post(`/api/admin/users/${EDITOR.id}/password`)
            .set('Cookie', owner)
            .send({ password: 'corta' })
            .expect(400)
        await http()
            .post(`/api/admin/users/${EDITOR.id}/password`)
            .set('Cookie', owner)
            .send({ password: 'Nueva-clave-2026' })
            .expect(204)

        const expired = await http().get('/api/auth/me').set('Cookie', editor).expect(401)
        expect(expired.body.message).toContain('Tu contraseña cambió')
        await http().get('/api/admin/users').set('Cookie', owner).expect(200)

        await http()
            .post('/api/auth/login')
            .send({ email: EDITOR.email, password: EDITOR.password })
            .expect(401)
        // Logging in right away (same second as the reset) works.
        const fresh = await login(EDITOR.email, 'Nueva-clave-2026')
        await http().get('/api/auth/me').set('Cookie', fresh).expect(200)
    })

    it('"Mi cuenta": rename and change the password, keeping only this session', async () => {
        const other = await login(EDITOR.email, EDITOR.password)
        const current = await login(EDITOR.email, EDITOR.password)

        const renamed = await http()
            .patch('/api/auth/me')
            .set('Cookie', current)
            .send({ name: '  Editora Nueva ' })
            .expect(200)
        expect(renamed.body).toMatchObject({ id: EDITOR.id, name: 'Editora Nueva' })
        expect(renamed.body.session.expiresInSeconds).toBeGreaterThan(0)
        await http()
            .patch('/api/auth/me')
            .set('Cookie', current)
            .send({ name: 'X', role: Role.ADMIN })
            .expect(400)

        const wrong = await http()
            .post('/api/auth/me/password')
            .set('Cookie', current)
            .send({ currentPassword: 'no-es-esta-1', newPassword: 'Nueva-clave-2026' })
            .expect(400)
        expect(wrong.body.details).toEqual([
            { field: 'currentPassword', errors: ['La contraseña actual no es correcta.'] },
        ])
        const weak = await http()
            .post('/api/auth/me/password')
            .set('Cookie', current)
            .send({ currentPassword: EDITOR.password, newPassword: 'sinnumero' })
            .expect(400)
        expect(
            (weak.body.details as FieldError[]).find((detail) => detail.field === 'newPassword')
                ?.errors,
        ).toEqual([
            'La nueva contraseña debe tener al menos 10 caracteres.',
            'La nueva contraseña debe incluir al menos un número.',
        ])

        const changed = await http()
            .post('/api/auth/me/password')
            .set('Cookie', current)
            .send({ currentPassword: EDITOR.password, newPassword: 'Nueva-clave-2026' })
            .expect(200)
        expect(changed.body).toMatchObject({ id: EDITOR.id, session: expect.any(Object) })
        const renewed = sessionCookie(changed.headers['set-cookie'])

        // The new cookie works at once; every older session (this one's old cookie included)
        // is closed.
        await http().get('/api/auth/me').set('Cookie', renewed).expect(200)
        await http().post('/api/auth/refresh').set('Cookie', renewed).expect(200)
        await http().get('/api/auth/me').set('Cookie', other).expect(401)
        await http().get('/api/auth/me').set('Cookie', current).expect(401)
        await login(EDITOR.email, 'Nueva-clave-2026')
    })
})
