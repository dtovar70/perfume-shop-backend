import type { INestApplication } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { catalogRepository } from './fixtures/catalogs.js'

/**
 * Boots the full application module with the TypeORM DataSource replaced by a stub, so the
 * HTTP layer (prefix, guards, validation) can be exercised without a database.
 */
const dataSourceStub = {
    isInitialized: false,
    entityMetadatas: [],
    options: { type: 'postgres' },
    manager: {},
    query: vi.fn((sql: string) => Promise.resolve(sql === 'SELECT 1' ? [{ '?column?': 1 }] : [])),
    getRepository: (entity: unknown) =>
        catalogRepository(entity) ?? { findOneBy: () => Promise.resolve(null) },
}

describe('App (e2e)', () => {
    let app: INestApplication

    beforeEach(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        })
            .overrideProvider(getDataSourceToken())
            .useValue(dataSourceStub)
            .compile()

        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.useGlobalPipes(createValidationPipe())
        await app.init()
    })

    afterEach(async () => {
        await app.close()
    })

    it('GET /api/health is public and pings the database', async () => {
        dataSourceStub.query.mockClear()
        await request(app.getHttpServer())
            .get('/api/health')
            .expect(200)
            .expect({ status: 'ok', database: 'up' })
        expect(dataSourceStub.query).toHaveBeenCalledWith('SELECT 1')
    })

    it('GET /api/health answers 503 when the database is down', async () => {
        dataSourceStub.query.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        const response = await request(app.getHttpServer()).get('/api/health').expect(503)
        expect(response.body).toMatchObject({ status: 'error', database: 'down' })
    })

    it('GET /api/health is not throttled', async () => {
        for (let i = 0; i < 130; i++) {
            await request(app.getHttpServer()).get('/api/health').expect(200)
        }
    })

    it('GET /api/auth/me without a session is rejected', () => {
        return request(app.getHttpServer()).get('/api/auth/me').expect(401)
    })

    it('GET /api/admin/products with an invalid session is rejected', () => {
        return request(app.getHttpServer())
            .get('/api/admin/products')
            .set('Cookie', 'kz_session=not-a-jwt')
            .expect(401)
    })

    it('DELETE /api/admin/categories/:slug without a session is rejected', () => {
        return request(app.getHttpServer()).delete('/api/admin/categories/arabes').expect(401)
    })

    it('GET /api/products rejects unknown sort values with a Spanish message', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/products?sort=cheapest')
            .expect(400)
        expect(response.body).toMatchObject({
            message: 'Los datos enviados no son válidos. Revisa los campos marcados.',
        })
    })

    it('GET /api/products/featured rejects an out-of-range limit in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/products/featured?limit=999')
            .expect(400)
        expect(response.body.details).toEqual([
            { field: 'limit', errors: ['El límite no puede ser mayor que 24.'] },
        ])
    })

    it('GET /api/products/:slug/related rejects unknown query params in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/products/lattafa-khamrah/related?limit=2&foo=1')
            .expect(400)
        expect(response.body.details).toEqual([
            { field: 'foo', errors: ['El campo "foo" no está permitido.'] },
        ])
    })
})
