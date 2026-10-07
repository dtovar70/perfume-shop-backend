import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { CACHE_KEYS } from '../cache/cache-keys.js'
import { MemoryCache } from '../cache/memory-cache.js'
import {
    applyConditions,
    buildCatalogConditions,
    CATALOG_ORDER_BY,
    FEATURED_ORDER_BY,
    PRODUCT_ALIAS,
    type Condition,
} from './catalog-query.js'
import type { AvailabilityItemDto } from './dto/availability.dto.js'
import type { CatalogQueryDto } from './dto/catalog-query.dto.js'
import { ProductVariant } from './entities/product-variant.entity.js'
import { Product } from './entities/product.entity.js'
import { resolveAvailability, type AvailabilityDto } from './product-availability.js'
import { ProductRepository } from './product.repository.js'
import { toPublicProduct, type Paginated, type PublicProductDto } from './product.mapper.js'
import { FEATURED_LIMIT, PRODUCT_NOT_FOUND, RELATED_LIMIT } from './products.constants.js'

const ACTIVE = { clause: `${PRODUCT_ALIAS}.isActive = :isActive`, params: { isActive: true } }

export interface FacetCountDto {
    value: string
    count: number
}

/** `GET /products/facets`: what the catalog filters can offer, over the active products. */
export interface CatalogFacetsDto {
    priceMin: number
    priceMax: number
    brands: { slug: string; name: string; count: number }[]
    genders: FacetCountDto[]
    families: FacetCountDto[]
    concentrations: FacetCountDto[]
}

/** Read-only storefront catalog. Only active products are exposed. */
@Injectable()
export class CatalogService {
    constructor(
        private readonly products: ProductRepository,
        @InjectRepository(Product) private readonly productRows: Repository<Product>,
        @InjectRepository(ProductVariant) private readonly variantRows: Repository<ProductVariant>,
        private readonly cache: MemoryCache,
    ) {}

    /**
     * Live stock of cart lines (the cart keeps no stock of its own). Two indexed reads, whatever
     * the number of lines; inactive products are reported too, so the cart can say why.
     */
    async availability(items: readonly AvailabilityItemDto[]): Promise<AvailabilityDto[]> {
        const productIds = [...new Set(items.map((item) => item.productId))]
        const [products, variants] = await Promise.all([
            this.productRows.find({
                where: { id: In(productIds) },
                select: { id: true, stock: true, isActive: true },
            }),
            this.variantRows.find({
                where: { productId: In(productIds) },
                select: { id: true, productId: true, stock: true },
            }),
        ])
        return resolveAvailability(items, products, variants)
    }

    async list(query: CatalogQueryDto): Promise<Paginated<PublicProductDto>> {
        const page = await this.products.paginate(
            buildCatalogConditions(query),
            CATALOG_ORDER_BY[query.sort],
            query.page,
            query.pageSize,
        )
        return { ...page, items: page.items.map(toPublicProduct) }
    }

    featured(limit = FEATURED_LIMIT): Promise<PublicProductDto[]> {
        return this.cache.getOrSet(CACHE_KEYS.featured(limit), () => this.loadFeatured(limit))
    }

    private async loadFeatured(limit: number): Promise<PublicProductDto[]> {
        const ids = await this.products.findIds([ACTIVE], FEATURED_ORDER_BY, limit)
        return (await this.products.findByIds(ids)).map(toPublicProduct)
    }

    /**
     * Price range and the values (with their product counts) of every catalog filter, over the
     * active products, optionally of one category. Brands are only the active ones.
     */
    facets(category?: string): Promise<CatalogFacetsDto> {
        return this.cache.getOrSet(CACHE_KEYS.facets(category), () => this.loadFacets(category))
    }

    private async loadFacets(category: string | undefined): Promise<CatalogFacetsDto> {
        const conditions: Condition[] = buildCatalogConditions({ category })
        const base = () =>
            applyConditions(this.productRows.createQueryBuilder(PRODUCT_ALIAS), conditions)
        const countBy = async (column: string): Promise<FacetCountDto[]> => {
            const rows = await base()
                .select(`${PRODUCT_ALIAS}.${column}`, 'value')
                .addSelect('COUNT(*)', 'count')
                .andWhere(`${PRODUCT_ALIAS}.${column} IS NOT NULL`)
                .groupBy(`${PRODUCT_ALIAS}.${column}`)
                .orderBy('COUNT(*)', 'DESC')
                .addOrderBy(`${PRODUCT_ALIAS}.${column}`, 'ASC')
                .getRawMany<{ value: string; count: string }>()
            return rows.map((row) => ({ value: row.value, count: Number(row.count) }))
        }

        const [prices, brands, genders, families, concentrations] = await Promise.all([
            base()
                .select(`MIN(${PRODUCT_ALIAS}.price)`, 'min')
                .addSelect(`MAX(${PRODUCT_ALIAS}.price)`, 'max')
                .getRawOne<{ min: string | null; max: string | null }>(),
            base()
                .innerJoin(`${PRODUCT_ALIAS}.brand`, 'brand', 'brand.isActive = :brandActive', {
                    brandActive: true,
                })
                .select('brand.slug', 'slug')
                .addSelect('brand.name', 'name')
                .addSelect('COUNT(*)', 'count')
                .groupBy('brand.slug')
                .addGroupBy('brand.name')
                .addGroupBy('brand.sortOrder')
                .orderBy('brand.sortOrder', 'ASC')
                .addOrderBy('brand.name', 'ASC')
                .getRawMany<{ slug: string; name: string; count: string }>(),
            countBy('gender'),
            countBy('olfactoryFamily'),
            countBy('concentration'),
        ])
        return {
            priceMin: Number(prices?.min ?? 0),
            priceMax: Number(prices?.max ?? 0),
            brands: brands.map((row) => ({
                slug: row.slug,
                name: row.name,
                count: Number(row.count),
            })),
            genders,
            families,
            concentrations,
        }
    }

    async bySlug(slug: string): Promise<PublicProductDto> {
        const product = await this.products.findOneWithRelations({ slug, isActive: true })
        if (!product) throw new NotFoundException(PRODUCT_NOT_FOUND)
        return toPublicProduct(product)
    }

    /** Same category first (by relevance), then the rest of the catalog as a fallback. */
    async related(slug: string, limit = RELATED_LIMIT): Promise<PublicProductDto[]> {
        const product = await this.products.findOneWithRelations({ slug, isActive: true })
        if (!product) throw new NotFoundException(PRODUCT_NOT_FOUND)

        const notSelf = { clause: `${PRODUCT_ALIAS}.id <> :selfId`, params: { selfId: product.id } }
        const sameCategory = await this.products.findIds(
            [
                ACTIVE,
                notSelf,
                {
                    clause: `${PRODUCT_ALIAS}.categorySlug = :category`,
                    params: { category: product.categorySlug },
                },
            ],
            CATALOG_ORDER_BY.relevance,
            limit,
        )
        const missing = limit - sameCategory.length
        const fallback =
            missing > 0
                ? await this.products.findIds(
                      [
                          ACTIVE,
                          notSelf,
                          {
                              clause: `${PRODUCT_ALIAS}.categorySlug <> :category`,
                              params: { category: product.categorySlug },
                          },
                      ],
                      CATALOG_ORDER_BY.relevance,
                      missing,
                  )
                : []

        return (await this.products.findByIds([...sameCategory, ...fallback])).map(toPublicProduct)
    }
}
