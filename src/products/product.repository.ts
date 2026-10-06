import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
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
        const rows = await this.products.find({
            where: { id: In(ids) },
            relations: { brand: true, variants: true, images: true },
            order: {
                variants: { sortOrder: 'ASC', id: 'ASC' },
                images: { sortOrder: 'ASC', createdAt: 'ASC' },
            },
        })
        const byId = new Map(rows.map((row) => [row.id, row]))
        return ids.flatMap((id) => byId.get(id) ?? [])
    }

    async findOneWithRelations(where: { id: string } | { slug: string; isActive: true }) {
        const row = await this.products.findOne({ where, select: { id: true } })
        if (!row) return null
        const [product] = await this.findByIds([row.id])
        return product ?? null
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
