import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { corsOptions } from '../src/config/cors.js'
import { FakeDb } from './fixtures/fake-orders-db.js'

const STOREFRONT = 'https://kaizen.com'

/** The storefront lives on another origin: its checkout request needs a CORS preflight. */
describe('CORS (e2e)', () => {
    let app: INestApplication

    beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(new FakeDb().dataSource)
            .compile()
        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.enableCors(corsOptions([STOREFRONT]))
        await app.init()
    })

    afterEach(async () => {
        await app.close()
    })

    it('allows the checkout preflight with Content-Type and Idempotency-Key', async () => {
        const response = await request(app.getHttpServer())
            .options('/api/orders')
            .set('Origin', STOREFRONT)
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type,idempotency-key')
            .expect(204)
        expect(response.headers['access-control-allow-origin']).toBe(STOREFRONT)
        expect(response.headers['access-control-allow-credentials']).toBe('true')
        expect(response.headers['access-control-allow-methods']).toContain('POST')
        const allowed = (response.headers['access-control-allow-headers'] as string)
            .split(',')
            .map((header) => header.trim().toLowerCase())
        expect(allowed).toEqual(expect.arrayContaining(['content-type', 'idempotency-key']))
    })

    it('does not allow another origin', async () => {
        const response = await request(app.getHttpServer())
            .options('/api/orders')
            .set('Origin', 'https://evil.example')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type,idempotency-key')
        expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })
})
