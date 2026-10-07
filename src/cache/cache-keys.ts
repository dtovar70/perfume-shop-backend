import type { PublicBrandDto } from '../brands/brands.service.js'
import type { CategoryDto } from '../categories/categories.service.js'
import type { SiteContent } from '../content/content.types.js'
import type { ExchangeRate } from '../exchange-rate/entities/exchange-rate.entity.js'
import type { CatalogFacetsDto } from '../products/catalog.service.js'
import type { PublicProductDto } from '../products/product.mapper.js'
import type { CacheEntrySpec } from './memory-cache.js'

/**
 * Every cached value of the app: its key, its lifetime and (through the type parameter) what
 * it holds. Keys are only ever built here, so the invalidations (CacheInvalidator) and the
 * readers can never disagree on a string.
 */

/** Everything the storefront catalog shows; invalidated together by any catalog write. */
export const CATALOG_PREFIX = 'catalog:'
/** Catalog lists also expire on their own, as a safety net for writes made outside the API. */
const CATALOG_TTL_MS = 60_000
/**
 * Changes only through the admin, which always invalidates it: the long TTL only bounds how
 * long another instance (or a manual database edit) can go unseen.
 */
const CONTENT_TTL_MS = 10 * 60_000
/** Short: checkout prices orders with it, and a sync on another instance must show up soon. */
const EXCHANGE_RATE_TTL_MS = 60_000
/**
 * Crawlers fetch it rarely and every catalog write drops it (it lives under the catalog
 * prefix), so it can live longer than the lists.
 */
const SITEMAP_TTL_MS = 10 * 60_000

const entry = <T>(key: string, ttlMs: number): CacheEntrySpec<T> => ({ key, ttlMs })

export const CACHE_KEYS = {
    categories: () => entry<CategoryDto[]>(`${CATALOG_PREFIX}categories`, CATALOG_TTL_MS),
    brands: () => entry<PublicBrandDto[]>(`${CATALOG_PREFIX}brands`, CATALOG_TTL_MS),
    /** Per category (`*` = the whole catalog). */
    facets: (category: string | undefined) =>
        entry<CatalogFacetsDto>(`${CATALOG_PREFIX}facets:${category ?? '*'}`, CATALOG_TTL_MS),
    featured: (limit: number) =>
        entry<PublicProductDto[]>(`${CATALOG_PREFIX}featured:${limit}`, CATALOG_TTL_MS),
    /** The rendered `/sitemap.xml`. */
    sitemap: () => entry<string>(`${CATALOG_PREFIX}sitemap`, SITEMAP_TTL_MS),
    content: () => entry<SiteContent>('content:all', CONTENT_TTL_MS),
    latestExchangeRate: () =>
        entry<ExchangeRate | null>('exchange-rate:latest', EXCHANGE_RATE_TTL_MS),
} as const
