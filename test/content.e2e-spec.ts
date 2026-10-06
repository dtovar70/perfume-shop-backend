import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { User } from '../src/auth/entities/user.entity.js'
import { Role } from '../src/auth/role.enum.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { DEFAULT_SITE_CONTENT } from '../src/content/content.defaults.js'
import { catalogRepository } from './fixtures/catalogs.js'

const USERS = {
    admin: { id: 'admin-1', role: Role.ADMIN },
    editor: { id: 'editor-1', role: Role.EDITOR },
}

function userRow(id: string) {
    const user = Object.values(USERS).find((candidate) => candidate.id === id)
    return user
        ? {
              ...user,
              email: `${user.id}@example.com`,
              name: 'Staff',
              isActive: true,
              passwordChangedAt: null,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-01T00:00:00Z'),
          }
        : null
}

/** Nothing stored yet: every section renders its defaults. */
const contentRepository = {
    find: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({ affected: 0 }),
}

const dataSourceStub = {
    isInitialized: false,
    entityMetadatas: [],
    options: { type: 'postgres' },
    manager: {},
    getRepository: (entity: unknown) =>
        entity === User
            ? { findOneBy: ({ id }: { id: string }) => Promise.resolve(userRow(id)) }
            : (catalogRepository(entity) ?? contentRepository),
}

/**
 * Site content routes through the real global guards and validation, with the database stubbed.
 */
describe('Site content (e2e)', () => {
    let app: INestApplication
    let cookie: (user: keyof typeof USERS) => string

    beforeEach(async () => {
        vi.clearAllMocks()
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(dataSourceStub)
            .compile()

        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.use(cookieParser())
        app.useGlobalPipes(createValidationPipe())
        await app.init()

        const signer = new JwtService({ secret: app.get(ConfigService).get<string>('JWT_SECRET') })
        cookie = (user) =>
            `kz_session=${signer.sign({ sub: USERS[user].id, role: USERS[user].role }, { expiresIn: 600 })}`
    })

    afterEach(async () => {
        await app.close()
    })

    it('GET /api/content is public, returns the defaults and is revalidated with an ETag', async () => {
        const response = await request(app.getHttpServer()).get('/api/content').expect(200)
        expect(response.body).toEqual(DEFAULT_SITE_CONTENT)
        expect(response.headers['cache-control']).toBe('no-cache')
        expect(response.headers.etag).toBeDefined()

        await request(app.getHttpServer())
            .get('/api/content')
            .set('If-None-Match', response.headers.etag as string)
            .expect(304)
    })

    it('admin routes require a session', async () => {
        await request(app.getHttpServer()).get('/api/admin/content').expect(401)
        await request(app.getHttpServer())
            .put('/api/admin/content/general')
            .send(DEFAULT_SITE_CONTENT.general)
            .expect(401)
    })

    it('GET /api/admin/content lists every section with its metadata', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/admin/content')
            .set('Cookie', cookie('editor'))
            .expect(200)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.body.shipping).toEqual({
            section: 'shipping',
            value: DEFAULT_SITE_CONTENT.shipping,
            isDefault: true,
            updatedAt: null,
            updatedBy: null,
        })
    })

    it('PUT an unknown section is a 404', async () => {
        const response = await request(app.getHttpServer())
            .put('/api/admin/content/banner')
            .set('Cookie', cookie('admin'))
            .send({})
            .expect(404)
        expect(response.body.message).toBe('No existe la sección de contenido «banner».')
    })

    it('PUT with invalid data is a 400 with Spanish details per field', async () => {
        const response = await request(app.getHttpServer())
            .put('/api/admin/content/contact')
            .set('Cookie', cookie('editor'))
            .send({ ...DEFAULT_SITE_CONTENT.contact, email: 'hola', whatsapp: '412555' })
            .expect(400)
        expect(response.body.message).toBe(
            'Los datos enviados no son válidos. Revisa los campos marcados.',
        )
        expect(response.body.details).toEqual([
            {
                field: 'email',
                errors: ['El correo debe ser un correo válido, por ejemplo hola@correo.com.'],
            },
            {
                field: 'whatsapp',
                errors: ['El número de WhatsApp debe tener el formato 0412-5550134.'],
            },
        ])
        expect(contentRepository.query).not.toHaveBeenCalled()
    })

    it('PUT with valid data saves the whole section', async () => {
        const home = { ...DEFAULT_SITE_CONTENT.home, heroTitle: '  Regalos *que hablan*  ' }
        const response = await request(app.getHttpServer())
            .put('/api/admin/content/home')
            .set('Cookie', cookie('editor'))
            .send(home)
            .expect(200)

        const [, params] = contentRepository.query.mock.calls[0] as [string, unknown[]]
        expect(params[0]).toBe('home')
        expect(JSON.parse(params[1] as string)).toEqual({
            ...home,
            heroTitle: 'Regalos *que hablan*',
        })
        expect(params[2]).toBe(USERS.editor.id)
        expect(response.body.section).toBe('home')
    })

    it('only ADMIN can restore the defaults', async () => {
        await request(app.getHttpServer())
            .post('/api/admin/content/home/reset')
            .set('Cookie', cookie('editor'))
            .expect(403)
        const response = await request(app.getHttpServer())
            .post('/api/admin/content/home/reset')
            .set('Cookie', cookie('admin'))
            .expect(200)
        expect(contentRepository.delete).toHaveBeenCalledWith({ key: 'home' })
        expect(response.body.value).toEqual(DEFAULT_SITE_CONTENT.home)
    })
})
