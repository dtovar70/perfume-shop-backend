import type { ConfigService } from '@nestjs/config'
import type { Repository } from 'typeorm'
import type { Brand } from '../brands/entities/brand.entity.js'
import { CacheInvalidator } from '../cache/cache-invalidator.js'
import { MemoryCache } from '../cache/memory-cache.js'
import type { Env } from '../config/env.schema.js'
import type { Product } from '../products/entities/product.entity.js'
import { absoluteUrl, buildSitemapXml, escapeXml } from './sitemap-xml.js'
import { SitemapService } from './sitemap.service.js'

describe('sitemap XML', () => {
    it('escapes the XML entities', () => {
        expect(escapeXml(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;')
    })

    it('joins the site URL and a path with exactly one slash', () => {
        expect(absoluteUrl('https://kaizen.com/', '/catalogo')).toBe('https://kaizen.com/catalogo')
        expect(absoluteUrl('https://kaizen.com', '/')).toBe('https://kaizen.com/')
    })

    it('writes a urlset with lastmod only when known, and drops duplicates', () => {
        const xml = buildSitemapXml('https://kaizen.com', [
            { path: '/', lastmod: new Date('2026-10-01T12:00:00Z') },
            { path: '/catalogo?brand=a&b' },
            { path: '/' },
        ])
        expect(xml).toBe(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
                '  <url><loc>https://kaizen.com/</loc><lastmod>2026-10-01T12:00:00.000Z</lastmod></url>',
                '  <url><loc>https://kaizen.com/catalogo?brand=a&amp;b</loc></url>',
                '</urlset>',
                '',
            ].join('\n'),
        )
    })
})

describe('SitemapService', () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, n))
    const productRows = [
        { slug: 'sauvage', categorySlug: 'hombre', brandSlug: 'dior', updatedAt: day(3) },
        { slug: 'yara', categorySlug: 'arabes', brandSlug: 'lattafa', updatedAt: day(5) },
        { slug: 'khamrah', categorySlug: 'arabes', brandSlug: 'lattafa', updatedAt: day(2) },
    ]
    const brandRows = [
        { slug: 'dior', updatedAt: day(1) },
        { slug: 'lattafa', updatedAt: day(6) },
        // Active, but without active products: left out.
        { slug: 'armaf', updatedAt: day(7) },
    ]

    function setup() {
        const products = { find: vi.fn().mockResolvedValue(productRows) }
        const brands = { find: vi.fn().mockResolvedValue(brandRows) }
        const cache = new MemoryCache()
        const config = { get: () => 'https://kaizen.com' }
        const service = new SitemapService(
            products as unknown as Repository<Product>,
            brands as unknown as Repository<Brand>,
            cache,
            config as unknown as ConfigService<Env, true>,
        )
        return { service, products, brands, cache }
    }

    it('lists the static pages, categories, brands with products and every active product', async () => {
        const { service, products, brands } = setup()
        const xml = await service.xml()

        expect(products.find).toHaveBeenCalledWith(
            expect.objectContaining({ where: { isActive: true } }),
        )
        expect(brands.find).toHaveBeenCalledWith(
            expect.objectContaining({ where: { isActive: true } }),
        )
        const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
        expect(locs).toEqual([
            'https://kaizen.com/',
            'https://kaizen.com/catalogo',
            'https://kaizen.com/marcas',
            'https://kaizen.com/catalogo/arabes',
            'https://kaizen.com/catalogo/hombre',
            'https://kaizen.com/catalogo?brand=dior',
            'https://kaizen.com/catalogo?brand=lattafa',
            'https://kaizen.com/producto/sauvage',
            'https://kaizen.com/producto/yara',
            'https://kaizen.com/producto/khamrah',
        ])
        expect(xml).not.toContain('armaf')
    })

    it('dates each listing by its newest product (or the brand itself)', async () => {
        const { service } = setup()
        const xml = await service.xml()
        const lastmodOf = (loc: string) =>
            new RegExp(`<loc>${loc.replace(/[?.]/g, '\\$&')}</loc><lastmod>([^<]+)</lastmod>`).exec(
                xml,
            )?.[1]

        expect(lastmodOf('https://kaizen.com/catalogo/arabes')).toBe(day(5).toISOString())
        expect(lastmodOf('https://kaizen.com/catalogo?brand=lattafa')).toBe(day(6).toISOString())
        expect(lastmodOf('https://kaizen.com/catalogo?brand=dior')).toBe(day(3).toISOString())
        expect(lastmodOf('https://kaizen.com/producto/khamrah')).toBe(day(2).toISOString())
        expect(lastmodOf('https://kaizen.com/')).toBe(day(6).toISOString())
    })

    it('is cached until a catalog invalidation', async () => {
        const { service, products, cache } = setup()
        await service.xml()
        await service.xml()
        expect(products.find).toHaveBeenCalledTimes(1)

        new CacheInvalidator(cache).invalidate('catalog')
        await service.xml()
        expect(products.find).toHaveBeenCalledTimes(2)
    })
})
