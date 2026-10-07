import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { Brand } from '../src/brands/entities/brand.entity.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { API_PREFIX, GLOBAL_PREFIX_OPTIONS } from '../src/config/global-prefix.js'
import { Product } from '../src/products/entities/product.entity.js'
import { SITEMAP_MAX_AGE_SECONDS } from '../src/sitemap/sitemap.controller.js'
import { catalogRepository } from './fixtures/catalogs.js'

interface Row {
    isActive: boolean
    [key: string]: unknown
}

/** `find({ where: { isActive } })` over in-memory rows: all the sitemap asks of TypeORM. */
function rowsRepository(rows: Row[]) {
    return {
        find: vi.fn(({ where }: { where?: { isActive?: boolean } } = {}) =>
            Promise.resolve(
                rows.filter((row) => where?.isActive === undefined || row.isActive === where.isActive),
            ),
        ),
        findOneBy: () => Promise.resolve(null),
    }
}

describe('Sitemap (e2e)', () => {
    let app: INestApplication
    const updatedAt = new Date('2026-10-01T10:00:00.000Z')
    const products = rowsRepository([
        { slug: 'yara', categorySlug: 'arabes', brandSlug: 'lattafa', updatedAt, isActive: true },
        { slug: 'retirado', categorySlug: 'arabes', brandSlug: 'lattafa', updatedAt, isActive: false },
    ])
    const brands = rowsRepository([
        { slug: 'lattafa', updatedAt, isActive: true },
        { slug: 'oculta', updatedAt, isActive: false },
    ])
    const dataSource = {
        isInitialized: false,
        entityMetadatas: [],
        options: { type: 'postgres' },
        manager: {},
        query: vi.fn(() => Promise.resolve([])),
        getRepository: (entity: unknown) =>
            entity === Product
                ? products
                : entity === Brand
                  ? brands
                  : (catalogRepository(entity) ?? { findOneBy: () => Promise.resolve(null) }),
    }

    beforeEach(async () => {
        const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(getDataSourceToken())
            .useValue(dataSource)
            .compile()
        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix(API_PREFIX, GLOBAL_PREFIX_OPTIONS)
        app.useGlobalPipes(createValidationPipe())
        await app.init()
    })

    afterEach(async () => {
        await app.close()
    })

    it('GET /sitemap.xml is public, at the root, XML and cacheable', async () => {
        const siteUrl = app.get(ConfigService).get<string>('PUBLIC_SITE_URL') ?? ''
        const response = await request(app.getHttpServer()).get('/sitemap.xml').expect(200)

        expect(response.headers['content-type']).toBe('application/xml; charset=utf-8')
        expect(response.headers['cache-control']).toContain(
            `public, max-age=${SITEMAP_MAX_AGE_SECONDS}`,
        )
        const xml = response.text
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
        expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
        for (const path of [
            '/',
            '/catalogo',
            '/marcas',
            '/catalogo/arabes',
            '/catalogo?brand=lattafa',
            '/producto/yara',
        ]) {
            expect(xml).toContain(`<loc>${siteUrl}${path}</loc>`)
        }
        expect(xml).toContain(`<lastmod>${updatedAt.toISOString()}</lastmod>`)
        expect(xml).not.toContain('retirado')
        expect(xml).not.toContain('oculta')
    })

    it('is not served under the API prefix, and the rest of the API still is', async () => {
        await request(app.getHttpServer()).get('/api/sitemap.xml').expect(404)
        await request(app.getHttpServer()).get('/api/health').expect(200)
    })
})
