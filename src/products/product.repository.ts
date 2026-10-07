import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository, type FindManyOptions } from 'typeorm'
import {
    applyConditions,
    applyOrderBy,
    PRODUCT_ALIAS,
    resolvePageWindow,
    type Condition,
    type OrderBy,
} from './catalog-query.js'
import { Product } from './entities/product.entity.js'
import type { Paginated } from './product.mapper.js'

/**
 * Brand, variants and images of a product. `relationLoadStrategy: 'query'` loads each relation
 * with its own query (keyed by the product ids) instead of joining them all at once: one JOIN of
 * variants × images repeats every product row variants × images times. Relations are ordered in
 * memory (see `orderRelations`): with this strategy TypeORM still tries to ORDER BY the joined
 * columns in the main query, which then fails because nothing is joined there.
 */
const WITH_RELATIONS = {
    relations: { brand: true, variants: true, images: true },
    relationLoadStrategy: 'query',
} as const satisfies FindManyOptions<Product>

/** Variants by position (then id), images by position (then upload time), as the admin set them. */
function orderRelations(product: Product): Product {
    product.variants.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    product.images.sort(
        (a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    return product
}

/**
 * Read helpers shared by the catalog and admin services. Pages are resolved in two steps
 * (ids first, then the full rows with brand/variants/images) so LIMIT/OFFSET never interacts
 * with the one-to-many joins.
 */
@Injectable()
export class ProductRepository {
    constructor(@InjectRepository(Product) private readonly products: Repository<Product>) {}

    /** Loads products with their brand and ordered variants and images, preserving the order of `ids`. */
    async findByIds(ids: string[]): Promise<Product[]> {
        if (!ids.length) return []
        const rows = await this.products.find({ where: { id: In(ids) }, ...WITH_RELATIONS })
        const byId = new Map(rows.map((row) => [row.id, orderRelations(row)]))
        return ids.flatMap((id) => byId.get(id) ?? [])
    }

    /** One product with its relations, found directly by id or by (active) slug. */
    async findOneWithRelations(
        where: { id: string } | { slug: string; isActive: true },
    ): Promise<Product | null> {
        const product = await this.products.findOne({ where, ...WITH_RELATIONS })
        return product && orderRelations(product)
    }

    /** Ordered ids matching the conditions, optionally limited. */
    async findIds(conditions: Condition[], orderBy: OrderBy, limit?: number): Promise<string[]> {
        const query = applyOrderBy(
            applyConditions(this.products.createQueryBuilder(PRODUCT_ALIAS), conditions),
            orderBy,
        ).select(`${PRODUCT_ALIAS}.id`, 'id')
        if (limit !== undefined) query.limit(limit)
        const rows = await query.getRawMany<{ id: string }>()
        return rows.map((row) => row.id)
    }

    async paginate(
        conditions: Condition[],
        orderBy: OrderBy,
        page: number,
        pageSize: number,
    ): Promise<Paginated<Product>> {
        const total = await applyConditions(
            this.products.createQueryBuilder(PRODUCT_ALIAS),
            conditions,
        ).getCount()
        const window = resolvePageWindow(total, page, pageSize)

        const rows = await applyOrderBy(
            applyConditions(this.products.createQueryBuilder(PRODUCT_ALIAS), conditions),
            orderBy,
        )
            .select(`${PRODUCT_ALIAS}.id`, 'id')
            .offset(window.skip)
            .limit(window.pageSize)
            .getRawMany<{ id: string }>()

        return {
            items: await this.findByIds(rows.map((row) => row.id)),
            page: window.page,
            pageSize: window.pageSize,
            total: window.total,
            totalPages: window.totalPages,
        }
    }
}
