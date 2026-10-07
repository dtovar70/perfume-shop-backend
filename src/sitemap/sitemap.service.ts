import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Brand } from '../brands/entities/brand.entity.js'
import { CACHE_KEYS } from '../cache/cache-keys.js'
import { MemoryCache } from '../cache/memory-cache.js'
import type { Env } from '../config/env.schema.js'
import { Product } from '../products/entities/product.entity.js'
import { buildSitemapXml, type SitemapEntry } from './sitemap-xml.js'

/**
 * Storefront paths. Mirror of the frontend's `src/constants/route.constant.ts`: keep both in
 * line if a route is renamed.
 */
export const SITEMAP_PATHS = {
    home: '/',
    catalog: '/catalogo',
    brands: '/marcas',
    category: (slug: string) => `/catalogo/${encodeURIComponent(slug)}`,
    brand: (slug: string) => `/catalogo?brand=${encodeURIComponent(slug)}`,
    product: (slug: string) => `/producto/${encodeURIComponent(slug)}`,
} as const

function latest(dates: readonly (Date | null | undefined)[]): Date | null {
    let max: Date | null = null
    for (const date of dates) if (date && (!max || date > max)) max = date
    return max
}

/**
 * `GET /sitemap.xml`: the home, the catalog, the brands page, every category and brand that has
 * active products, and every active product, on the storefront's address (`PUBLIC_SITE_URL`).
 * Categories and brands without active products are left out (an empty listing is thin content).
 * Cached under the catalog prefix, so every catalog write and stock change drops it.
 */
@Injectable()
export class SitemapService {
    private readonly siteUrl: string

    constructor(
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(Brand) private readonly brands: Repository<Brand>,
        private readonly cache: MemoryCache,
        config: ConfigService<Env, true>,
    ) {
        this.siteUrl = config.get('PUBLIC_SITE_URL', { infer: true })
    }

    xml(): Promise<string> {
        return this.cache.getOrSet(CACHE_KEYS.sitemap(), () => this.build())
    }

    private async build(): Promise<string> {
        const [products, brands] = await Promise.all([
            this.products.find({
                where: { isActive: true },
                select: { slug: true, categorySlug: true, brandSlug: true, updatedAt: true },
                order: { slug: 'ASC' },
            }),
            this.brands.find({
                where: { isActive: true },
                select: { slug: true, updatedAt: true },
                order: { slug: 'ASC' },
            }),
        ])

        // Each listing changes when one of its products does.
        const categoryLastmod = new Map<string, Date | null>()
        const brandLastmod = new Map<string, Date | null>()
        for (const product of products) {
            const touch = (map: Map<string, Date | null>, key: string | null) => {
                if (key) map.set(key, latest([map.get(key), product.updatedAt]))
            }
            touch(categoryLastmod, product.categorySlug)
            touch(brandLastmod, product.brandSlug)
        }
        const activeBrands = brands.filter((brand) => brandLastmod.has(brand.slug))
        const catalogLastmod = latest([
            ...products.map((product) => product.updatedAt),
            ...activeBrands.map((brand) => brand.updatedAt),
        ])

        const entries: SitemapEntry[] = [
            { path: SITEMAP_PATHS.home, lastmod: catalogLastmod },
            { path: SITEMAP_PATHS.catalog, lastmod: catalogLastmod },
            { path: SITEMAP_PATHS.brands, lastmod: latest(activeBrands.map((b) => b.updatedAt)) },
            ...[...categoryLastmod.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([slug, lastmod]) => ({ path: SITEMAP_PATHS.category(slug), lastmod })),
            ...activeBrands.map((brand) => ({
                path: SITEMAP_PATHS.brand(brand.slug),
                lastmod: latest([brand.updatedAt, brandLastmod.get(brand.slug)]),
            })),
            ...products.map((product) => ({
                path: SITEMAP_PATHS.product(product.slug),
                lastmod: product.updatedAt,
            })),
        ]
        return buildSitemapXml(this.siteUrl, entries)
    }
}
