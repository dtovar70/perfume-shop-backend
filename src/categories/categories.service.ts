import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { slugify } from '../common/utils/text.util.js'
import { isDbError, omitUndefined } from '../database/db-errors.js'
import { Product } from '../products/entities/product.entity.js'
import { detectMediaType, mediaKind } from '../storage/media-type.js'
import {
    STORAGE_SERVICE,
    type StorageService,
    type StoredFile,
} from '../storage/storage.service.js'
import { INVALID_CATEGORY_IMAGE_TYPE } from './category-image-upload.js'
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
    /** Cover uploaded (or linked) from the admin; null when there is none. */
    imageUrl: string | null
    /**
     * Fallback for the card when there is no cover: the first photo of the category's best
     * active product (featured first, then by relevance). Null when no product has a photo.
     */
    previewImageUrl: string | null
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

/**
 * For each category (or only `$1`), the first photo of its best active product: featured first,
 * then by relevance, newest, id. One query: `DISTINCT ON` keeps the top product per category and
 * the lateral join picks its first image (products without photos never qualify).
 */
const PREVIEW_IMAGES_SQL = (oneCategory: boolean) => `
    SELECT DISTINCT ON (p."category_slug") p."category_slug" AS "slug", img."url" AS "url"
    FROM "products" p
    CROSS JOIN LATERAL (
        SELECT i."url"
        FROM "product_images" i
        WHERE i."product_id" = p."id"
        ORDER BY i."sort_order" ASC, i."created_at" ASC
        LIMIT 1
    ) img
    WHERE p."is_active"${oneCategory ? ' AND p."category_slug" = $1' : ''}
    ORDER BY p."category_slug", p."is_featured" DESC, p."relevance_score" DESC,
        p."created_at" DESC, p."id" ASC
`

/** The cover columns a create or update writes. */
type ImageChange = Pick<Category, 'imageUrl' | 'imagePublicId'>

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
    private readonly logger = new Logger(CategoriesService.name)

    constructor(
        @InjectRepository(Category) private readonly categories: Repository<Category>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    ) {}

    /** Public list, in menu order, with the count of visible products and the card images. */
    async list(): Promise<CategoryDto[]> {
        const [categories, counts, previews] = await Promise.all([
            this.findOrdered(),
            this.productCounts(),
            this.previewImages(),
        ])
        return categories.map((category) =>
            toDto(category, counts.get(category.slug), previews.get(category.slug)),
        )
    }

    /** Admin list: same order, plus the position and the count of every product. */
    async listForAdmin(): Promise<AdminCategoryDto[]> {
        const [categories, counts, previews] = await Promise.all([
            this.findOrdered(),
            this.productCounts(),
            this.previewImages(),
        ])
        return categories.map((category) =>
            toAdminDto(category, counts.get(category.slug), previews.get(category.slug)),
        )
    }

    /** `image`: an uploaded cover (multipart), stored under `categories/`; wins over `imageUrl`. */
    async create(dto: CreateCategoryDto, image?: Express.Multer.File): Promise<AdminCategoryDto> {
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

        const sortOrder = dto.sortOrder ?? (await this.nextSortOrder())
        const stored = image ? await this.storeImage(image) : null
        const category: CategoryRow = {
            slug,
            name: dto.name,
            tagline: dto.tagline ?? '',
            description: dto.description ?? '',
            colorHex: dto.colorHex,
            sortOrder,
            imageUrl: stored?.url ?? (dto.removeImage ? null : (dto.imageUrl ?? null)),
            imagePublicId: stored?.publicId ?? null,
        }
        try {
            await this.categories.insert(category)
        } catch (error) {
            if (stored) await this.deleteImage(stored.publicId)
            // Two requests with the same slug can both pass the check above.
            if (isDbError(error, '23505')) throw new ConflictException(slugTakenMessage(slug))
            throw error
        }
        // A new category has no products yet, hence no counts and no preview.
        return toAdminDto(category, NO_PRODUCTS, null)
    }

    /**
     * Partial update. A new `image` file replaces the cover; `removeImage: true`, `imageUrl: null`
     * (or blank) removes it and an `imageUrl` replaces it. A replaced uploaded file is deleted
     * from storage afterwards.
     */
    async update(
        slug: string,
        dto: UpdateCategoryDto,
        image?: Express.Multer.File,
    ): Promise<AdminCategoryDto> {
        const category = await this.categories.findOneBy({ slug })
        if (!category) throw new NotFoundException(CATEGORY_NOT_FOUND)

        const stored = image ? await this.storeImage(image) : null
        const { imageUrl, removeImage, ...fields } = dto
        let imageChange: ImageChange | null = null
        if (stored) imageChange = { imageUrl: stored.url, imagePublicId: stored.publicId }
        else if (removeImage) imageChange = { imageUrl: null, imagePublicId: null }
        else if (imageUrl !== undefined && imageUrl !== category.imageUrl) {
            imageChange = { imageUrl, imagePublicId: null }
        }

        const changes: Partial<CategoryRow> = { ...omitUndefined({ ...fields }), ...imageChange }
        if (Object.keys(changes).length) {
            try {
                await this.categories.update({ slug }, changes)
            } catch (error) {
                if (stored) await this.deleteImage(stored.publicId)
                throw error
            }
        }
        if (imageChange && category.imagePublicId) await this.deleteImage(category.imagePublicId)

        const updated = { ...category, ...changes }
        const [counts, previews] = await Promise.all([
            this.productCounts(slug),
            this.previewImages(slug),
        ])
        return toAdminDto(updated, counts.get(slug), previews.get(slug))
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
        const category = await this.categories.findOne({
            where: { slug },
            select: { slug: true, imagePublicId: true },
        })
        if (!category) throw new NotFoundException(CATEGORY_NOT_FOUND)
        await this.assertEmpty(slug)

        try {
            const result = await this.categories.delete({ slug })
            if (!result.affected) throw new NotFoundException(CATEGORY_NOT_FOUND)
        } catch (error) {
            // A product was added between the check and the delete.
            if (isDbError(error, '23503')) await this.assertEmpty(slug)
            throw error
        }
        if (category.imagePublicId) await this.deleteImage(category.imagePublicId)
    }

    /** Checks the real file type (JPG, PNG, WEBP or AVIF) before storing the cover. */
    private async storeImage(file: Express.Multer.File): Promise<StoredFile> {
        const type = detectMediaType(file.buffer)
        if (!type || mediaKind(type) !== 'image') {
            throw new BadRequestException(INVALID_CATEGORY_IMAGE_TYPE)
        }
        try {
            return await this.storage.uploadMedia({ buffer: file.buffer, type }, 'categories')
        } catch (error) {
            this.logger.error('Category image upload failed', error as Error)
            throw new BadRequestException('No pudimos guardar la imagen. Intenta de nuevo.')
        }
    }

    /** A failure only leaves an orphan file. */
    private async deleteImage(publicId: string): Promise<void> {
        await this.storage.deleteMedia({ publicId, kind: 'image' }).catch((error: unknown) => {
            this.logger.warn(`Could not delete category image "${publicId}": ${String(error)}`)
        })
    }

    /** Preview photo per category slug (optionally for a single category); see the SQL. */
    private async previewImages(slug?: string): Promise<Map<string, string>> {
        const rows: { slug: string; url: string }[] = await this.products.query(
            PREVIEW_IMAGES_SQL(slug !== undefined),
            slug !== undefined ? [slug] : [],
        )
        return new Map(rows.map((row) => [row.slug, row.url]))
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

/** `imagePublicId` is internal and never leaves the API. */
function toDto(
    category: CategoryRow,
    counts: ProductCounts = NO_PRODUCTS,
    previewImageUrl: string | null = null,
): CategoryDto {
    return {
        slug: category.slug,
        name: category.name,
        tagline: category.tagline,
        description: category.description,
        colorHex: category.colorHex,
        imageUrl: category.imageUrl,
        previewImageUrl,
        productCount: counts.active,
    }
}

function toAdminDto(
    category: CategoryRow,
    counts: ProductCounts = NO_PRODUCTS,
    previewImageUrl: string | null = null,
): AdminCategoryDto {
    return {
        ...toDto(category, counts, previewImageUrl),
        sortOrder: category.sortOrder,
        totalProductCount: counts.total,
    }
}
