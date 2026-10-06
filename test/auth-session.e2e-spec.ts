import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { Role } from '../src/auth/role.enum.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { catalogRepository } from './fixtures/catalogs.js'

const USER = {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Admin',
    role: Role.ADMIN,
    isActive: true,
    passwordChangedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
}

/** Repository stub: only USER exists (plus the seeded catalogs the startup check reads). */
const dataSourceStub = {
    isInitialized: false,
    entityMetadatas: [],
    options: { type: 'postgres' },
    manager: {},
    getRepository: (entity: unknown) =>
        catalogRepository(entity) ?? {
            findOneBy: ({ id }: { id: string }) => Promise.resolve(id === USER.id ? USER : null),
        },
}

interface SessionBody {
    id: string
    session: {
        expiresAt: string
        expiresInSeconds: number
        ttlSeconds: number
        idleMinutes: number
        promptSeconds: number
    }
}

/**
 * Session lifetime and `POST /api/auth/refresh`, through the real global guards
 * (JwtAuthGuard + RolesGuard + ThrottlerGuard) with the database stubbed out.
 */
describe('Auth session (e2e)', () => {
    let app: INestApplication
    let signer: JwtService
    let ttlSeconds: number

    const nowSeconds = () => Math.floor(Date.now() / 1000)
    const cookieFor = (claims: Record<string, unknown>) =>
        `kz_session=${signer.sign({ role: Role.ADMIN, ...claims })}`

    beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(dataSourceStub)
            .compile()

        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.use(cookieParser())
        app.useGlobalPipes(createValidationPipe())
        await app.init()

        const config = app.get(ConfigService)
        // No default expiry: every test sets iat/exp explicitly.
        signer = new JwtService({ secret: config.get<string>('JWT_SECRET') })
        ttlSeconds =
            config.get<number>('SESSION_IDLE_MINUTES')! * 60 +
            config.get<number>('SESSION_PROMPT_SECONDS')! +
            60
    })

    afterEach(async () => {
        await app.close()
    })

    it('POST /api/auth/refresh without a session is rejected', () => {
        return request(app.getHttpServer()).post('/api/auth/refresh').expect(401)
    })

    it('POST /api/auth/refresh with an expired token is rejected', () => {
        const iat = nowSeconds() - ttlSeconds - 10
        return request(app.getHttpServer())
            .post('/api/auth/refresh')
            .set('Cookie', cookieFor({ sub: USER.id, iat, exp: iat + ttlSeconds }))
            .expect(401)
    })

    it('rejects a still-valid token longer than the configured lifetime (old 7-day token)', () => {
        const iat = nowSeconds() - 60
        return request(app.getHttpServer())
            .get('/api/auth/me')
            .set('Cookie', cookieFor({ sub: USER.id, iat, exp: iat + 7 * 86_400 }))
            .expect(401)
    })

    it('does not re-issue a session for a user that no longer exists', () => {
        const iat = nowSeconds()
        return request(app.getHttpServer())
            .post('/api/auth/refresh')
            .set('Cookie', cookieFor({ sub: 'deleted-user', iat, exp: iat + ttlSeconds }))
            .expect(401)
    })

    it('GET /api/auth/me returns the current token expiry and the prompt settings', async () => {
        const iat = nowSeconds() - 120
        const exp = iat + ttlSeconds
        const response = await request(app.getHttpServer())
            .get('/api/auth/me')
            .set('Cookie', cookieFor({ sub: USER.id, iat, exp }))
            .expect(200)

        const body = response.body as SessionBody
        expect(body.id).toBe(USER.id)
        expect(body.session.expiresAt).toBe(new Date(exp * 1000).toISOString())
        expect(body.session.ttlSeconds).toBe(ttlSeconds)
        expect(body.session.expiresInSeconds).toBeLessThanOrEqual(ttlSeconds - 120)
        expect(body.session.idleMinutes).toBeGreaterThan(0)
        expect(body.session.promptSeconds).toBeGreaterThan(0)
        expect(response.headers['set-cookie']).toBeUndefined()
    })

    it('POST /api/auth/refresh re-issues the cookie with a later expiry', async () => {
        const iat = nowSeconds() - 120
        const exp = iat + ttlSeconds
        const response = await request(app.getHttpServer())
            .post('/api/auth/refresh')
            .set('Cookie', cookieFor({ sub: USER.id, iat, exp }))
            .expect(200)

        const body = response.body as SessionBody
        expect(body.id).toBe(USER.id)
        expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(exp * 1000)
        expect(body.session.expiresInSeconds).toBeGreaterThanOrEqual(ttlSeconds - 1)

        const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? [])
        const session = setCookie.find((cookie) => cookie.startsWith('kz_session='))
        expect(session).toBeDefined()
        expect(session).toMatch(/HttpOnly/i)
        expect(session).toMatch(new RegExp(`Max-Age=(${ttlSeconds}|${ttlSeconds - 1});`))
    })
})
