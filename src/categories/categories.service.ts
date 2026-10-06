import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { slugify } from '../common/utils/text.util.js'
import { isDbError, omitUndefined } from '../database/db-errors.js'
import { Product } from '../products/entities/product.entity.js'
import type { CreateCategoryDto } from './dto/create-category.dto.js'
import { CATEGORY_SLUG_MAX_LENGTH } from './dto/field-names.js'
import type { UpdateCategoryDto } from './dto/update-category.dto.js'
import { Category } from './entities/category.entity.js'

/** A category row as the mappers need it (no relations loaded). */
export type CategoryRow = Omit<Category, 'products'>

export const CATEGORY_NOT_FOUND = 'No encontramos la categoría solicitada.'

/** Sub-route of `admin/categories` used to reorder; reserved so no category slug can shadow it. */
export const CATEGORY_ORDER_ROUTE = 'order'

export const CATEGORY_ORDER_MISMATCH =
    'La lista debe incluir exactamente todas las categorías, cada una una sola vez.'

/** Matches `Category` in frontend-perfume-shop/src/@types/product.ts. */
export interface CategoryDto {
    slug: string
    name: string
    tagline: string
    description: string
    colorHex: string
    /** Number of active products in the category. */
    productCount: number
}

/** Matches `AdminCategory` in frontend-perfume-shop/src/@types/admin.ts. */
export interface AdminCategoryDto extends CategoryDto {
    sortOrder: number
    /** Every product in the category, hidden ones included. Deleting requires zero. */
    totalProductCount: number
}

interface ProductCounts {
    active: number
    total: number
}

const NO_PRODUCTS: ProductCounts = { active: 0, total: 0 }

/** "tiene 1 producto. Muévelo…" / "tiene 6 productos. Muévelos…" */
export function categoryInUseMessage(count: number): string {
    return count === 1
        ? 'No puedes eliminar esta categoría porque tiene 1 producto. Muévelo a otra categoría o elimínalo primero.'
        : `No puedes eliminar esta categoría porque tiene ${count} productos. Muévelos a otra categoría o elimínalos primero.`
}

function slugTakenMessage(slug: string): string {
    return `Ya existe una categoría con el slug "${slug}".`
}

@Injectable()
export class CategoriesService {
    constructor(
        @InjectRepository(Category) private readonly categories: Repository<Category>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
    ) {}

    /** Public list, in menu order, with the count of visible products. */
    async list(): Promise<CategoryDto[]> {
        const [categories, counts] = await Promise.all([this.findOrdered(), this.productCounts()])
        return categories.map((category) => toDto(category, counts.get(category.slug)))
    }

    /** Admin list: same order, plus the position and the count of every product. */
    async listForAdmin(): Promise<AdminCategoryDto[]> {
        const [categories, counts] = await Promise.all([this.findOrdered(), this.productCounts()])
        return categories.map((category) => toAdminDto(category, counts.get(category.slug)))
    }

    async create(dto: CreateCategoryDto): Promise<AdminCategoryDto> {
        const slug = dto.slug ?? slugify(dto.name).slice(0, CATEGORY_SLUG_MAX_LENGTH)
        if (!slug) {
            throw new BadRequestException(
                'No pudimos generar un slug a partir del nombre. Escribe uno a mano.',
            )
        }
        if (slug === CATEGORY_ORDER_ROUTE) {
            throw new BadRequestException(`El slug "${slug}" está reservado. Elige otro.`)
        }
        if (await this.categories.existsBy({ slug })) {
            throw new ConflictException(slugTakenMessage(slug))
        }

        const category: CategoryRow = {
            slug,
            name: dto.name,
            tagline: dto.tagline ?? '',
            description: dto.description ?? '',
            colorHex: dto.colorHex,
            sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
        }
        try {
            await this.categories.insert(category)
        } catch (error) {
            // Two requests with the same slug can both pass the check above.
            if (isDbError(error, '23505')) throw new ConflictException(slugTakenMessage(slug))
            throw error
        }
        return toAdminDto(category, NO_PRODUCTS)
    }

    async update(slug: string, dto: UpdateCategoryDto): Promise<AdminCategoryDto> {
        const category = await this.categories.findOneBy({ slug })
        if (!category) throw new NotFoundException(CATEGORY_NOT_FOUND)

        const changes = omitUndefined({ ...dto })
        if (Object.keys(changes).length) {
            await this.categories.update({ slug }, changes)
        }
        const updated = { ...category, ...changes }
        const counts = await this.productCounts(slug)
        return toAdminDto(updated, counts.get(slug))
    }

    /**
     * Rewrites every position as 0..n-1 following `slugs`, which must be exactly the set of
     * existing slugs. Runs in one transaction so the menu never shows a half-applied order.
     */
    async reorder(slugs: string[]): Promise<AdminCategoryDto[]> {
        await this.categories.manager.transaction(async (manager) => {
            const current = await manager.find(Category, { select: { slug: true } })
            const currentSlugs = new Set(current.map((category) => category.slug))
            const sameSet =
                currentSlugs.size === slugs.length &&
                new Set(slugs).size === slugs.length &&
                slugs.every((slug) => currentSlugs.has(slug))
            if (!sameSet) throw new BadRequestException(CATEGORY_ORDER_MISMATCH)

            for (const [index, slug] of slugs.entries()) {
                await manager.update(Category, { slug }, { sortOrder: index })
            }
        })
        return this.listForAdmin()
    }

    /**
     * Only empty categories can be deleted. The `products.category_slug` foreign key is
     * `ON DELETE RESTRICT` as a safety net; this check exists to give a helpful message.
     */
    async remove(slug: string): Promise<void> {
        if (!(await this.categories.existsBy({ slug }))) {
            throw new NotFoundException(CATEGORY_NOT_FOUND)
        }
        await this.assertEmpty(slug)

        try {
            const result = await this.categories.delete({ slug })
            if (!result.affected) throw new NotFoundException(CATEGORY_NOT_FOUND)
        } catch (error) {
            // A product was added between the check and the delete.
            if (isDbError(error, '23503')) await this.assertEmpty(slug)
            throw error
        }
    }

    private async assertEmpty(slug: string): Promise<void> {
        const count = await this.products.countBy({ categorySlug: slug })
        if (count > 0) throw new ConflictException(categoryInUseMessage(count))
    }

    private findOrdered(): Promise<Category[]> {
        return this.categories.find({ order: { sortOrder: 'ASC', slug: 'ASC' } })
    }

    private async nextSortOrder(): Promise<number> {
        const row = await this.categories
            .createQueryBuilder('category')
            .select('MAX(category.sortOrder)', 'max')
            .getRawOne<{ max: number | null }>()
        return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1
    }

    /** Active and total product counts per category slug (optionally for a single category). */
    private async productCounts(slug?: string): Promise<Map<string, ProductCounts>> {
        const query = this.products
            .createQueryBuilder('product')
            .select('product.categorySlug', 'slug')
            .addSelect('COUNT(*) FILTER (WHERE product.isActive)', 'active')
            .addSelect('COUNT(*)', 'total')
            .groupBy('product.categorySlug')
        if (slug) query.where('product.categorySlug = :slug', { slug })

        const rows = await query.getRawMany<{
            slug: string
            active: string
            total: string
        }>()
        return new Map(
            rows.map((row) => [row.slug, { active: Number(row.active), total: Number(row.total) }]),
        )
    }
}

function toDto(category: CategoryRow, counts: ProductCounts = NO_PRODUCTS): CategoryDto {
    return {
        slug: category.slug,
        name: category.name,
        tagline: category.tagline,
        description: category.description,
        colorHex: category.colorHex,
        productCount: counts.active,
    }
}

function toAdminDto(category: CategoryRow, counts: ProductCounts = NO_PRODUCTS): AdminCategoryDto {
    return {
        ...toDto(category, counts),
        sortOrder: category.sortOrder,
        totalProductCount: counts.total,
    }
}
