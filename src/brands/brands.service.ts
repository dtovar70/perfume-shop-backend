import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { slugify } from '../common/utils/text.util.js'
import { isDbError, omitUndefined } from '../database/db-errors.js'
import { Product } from '../products/entities/product.entity.js'
import { computeSearchText } from '../products/product-derived.js'
import { detectImageType } from '../storage/image-type.js'
import {
    STORAGE_SERVICE,
    type StorageService,
    type StoredFile,
} from '../storage/storage.service.js'
import type { CreateBrandDto } from './dto/create-brand.dto.js'
import { BRAND_SLUG_MAX_LENGTH } from './dto/field-names.js'
import type { UpdateBrandDto } from './dto/update-brand.dto.js'
import { Brand } from './entities/brand.entity.js'

export const BRAND_NOT_FOUND = 'No encontramos la marca solicitada.'

/** `GET /brands`: an active brand of the storefront. */
export interface PublicBrandDto {
    slug: string
    name: string
    logoUrl: string | null
    description: string
    /** Number of active products of the brand. */
    productCount: number
}

/** `admin/brands`: every brand, hidden ones included. */
export interface AdminBrandDto extends PublicBrandDto {
    sortOrder: number
    isActive: boolean
    /** Every product of the brand, hidden ones included. */
    totalProductCount: number
    createdAt: string
    updatedAt: string
}

interface ProductCounts {
    active: number
    total: number
}

const NO_PRODUCTS: ProductCounts = { active: 0, total: 0 }

function slugTakenMessage(slug: string): string {
    return `Ya existe una marca con el slug "${slug}".`
}

@Injectable()
export class BrandsService {
    private readonly logger = new Logger(BrandsService.name)

    constructor(
        @InjectRepository(Brand) private readonly brands: Repository<Brand>,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    ) {}

    /** Public list: active brands by position, then name, with their visible products. */
    async list(): Promise<PublicBrandDto[]> {
        const [brands, counts] = await Promise.all([
            this.brands.find({
                where: { isActive: true },
                order: { sortOrder: 'ASC', name: 'ASC' },
            }),
            this.productCounts(),
        ])
        return brands.map((brand) => toPublicDto(brand, counts.get(brand.slug)))
    }

    async listForAdmin(): Promise<AdminBrandDto[]> {
        const [brands, counts] = await Promise.all([
            this.brands.find({ order: { sortOrder: 'ASC', name: 'ASC' } }),
            this.productCounts(),
        ])
        return brands.map((brand) => toAdminDto(brand, counts.get(brand.slug)))
    }

    async get(slug: string): Promise<AdminBrandDto> {
        const brand = await this.brands.findOneBy({ slug })
        if (!brand) throw new NotFoundException(BRAND_NOT_FOUND)
        const counts = await this.productCounts(slug)
        return toAdminDto(brand, counts.get(slug))
    }

    /** `logo`: an uploaded image (multipart), stored like the product photos; wins over `logoUrl`. */
    async create(dto: CreateBrandDto, logo?: Express.Multer.File): Promise<AdminBrandDto> {
        const slug = dto.slug ?? slugify(dto.name).slice(0, BRAND_SLUG_MAX_LENGTH)
        if (!slug) {
            throw new BadRequestException(
                'No pudimos generar un slug a partir del nombre. Escribe uno a mano.',
            )
        }
        if (await this.brands.existsBy({ slug })) {
            throw new ConflictException(slugTakenMessage(slug))
        }

        const stored = logo ? await this.storeLogo(logo) : null
        try {
            await this.brands.insert({
                slug,
                name: dto.name,
                logoUrl: stored?.url ?? dto.logoUrl ?? null,
                logoPublicId: stored?.publicId ?? null,
                description: dto.description ?? '',
                sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
                isActive: dto.isActive ?? true,
            })
        } catch (error) {
            if (stored) await this.deleteLogo(stored.publicId)
            // Two requests with the same slug can both pass the check above.
            if (isDbError(error, '23505')) throw new ConflictException(slugTakenMessage(slug))
            throw error
        }
        return this.get(slug)
    }

    /**
     * Partial update. A new `logo` file replaces the stored one; `logoUrl` (or null) replaces the
     * logo too. A replaced uploaded logo is deleted from storage afterwards.
     */
    async update(
        slug: string,
        dto: UpdateBrandDto,
        logo?: Express.Multer.File,
    ): Promise<AdminBrandDto> {
        const current = await this.brands.findOneBy({ slug })
        if (!current) throw new NotFoundException(BRAND_NOT_FOUND)

        const stored = logo ? await this.storeLogo(logo) : null
        const { logoUrl, ...fields } = dto
        const changes: Partial<Brand> = omitUndefined({ ...fields })
        if (stored) {
            changes.logoUrl = stored.url
            changes.logoPublicId = stored.publicId
        } else if (logoUrl !== undefined) {
            changes.logoUrl = logoUrl
            changes.logoPublicId = null
        }

        if (Object.keys(changes).length) {
            try {
                await this.brands.update({ slug }, changes)
            } catch (error) {
                if (stored) await this.deleteLogo(stored.publicId)
                throw error
            }
        }
        const replacedLogo = 'logoUrl' in changes && current.logoPublicId
        if (replacedLogo && current.logoPublicId) await this.deleteLogo(current.logoPublicId)
        if (dto.name !== undefined && dto.name !== current.name) await this.refreshSearch(slug)
        return this.get(slug)
    }

    /** Its products stay, without a brand (`ON DELETE SET NULL`); an uploaded logo is deleted. */
    async remove(slug: string): Promise<void> {
        const brand = await this.brands.findOneBy({ slug })
        if (!brand) throw new NotFoundException(BRAND_NOT_FOUND)
        const productIds = (
            await this.products.find({ where: { brandSlug: slug }, select: { id: true } })
        ).map(({ id }) => id)

        await this.brands.delete({ slug })
        if (productIds.length) await this.refreshSearch(null, productIds)
        if (brand.logoPublicId) await this.deleteLogo(brand.logoPublicId)
    }

    private async storeLogo(file: Express.Multer.File): Promise<StoredFile> {
        const type = detectImageType(file.buffer)
        if (!type) {
            throw new BadRequestException(
                `El archivo "${file.originalname}" no es una imagen JPG, PNG o WEBP válida.`,
            )
        }
        try {
            return await this.storage.upload({ buffer: file.buffer, type }, 'brands')
        } catch (error) {
            this.logger.error('Brand logo upload failed', error as Error)
            throw new BadRequestException('No pudimos guardar el logo. Intenta de nuevo.')
        }
    }

    /** A failure only leaves an orphan file. */
    private async deleteLogo(publicId: string): Promise<void> {
        await this.storage.delete(publicId).catch((error: unknown) => {
            this.logger.warn(`Could not delete stored logo "${publicId}": ${String(error)}`)
        })
    }

    /**
     * The products' search text includes the brand's name: rebuilt after a rename (for the
     * brand's products) or a delete (for the products it had, `ids`).
     */
    private async refreshSearch(slug: string | null, ids?: string[]): Promise<void> {
        const rows = await this.products.find({
            where: ids ? { id: In(ids) } : { brandSlug: slug ?? undefined },
            relations: { brand: true },
        })
        for (const product of rows) {
            await this.products.update(
                { id: product.id },
                {
                    searchText: computeSearchText({
                        ...product,
                        brandName: product.brand?.name ?? null,
                    }),
                },
            )
        }
    }

    private async nextSortOrder(): Promise<number> {
        const row = await this.brands
            .createQueryBuilder('brand')
            .select('MAX(brand.sortOrder)', 'max')
            .getRawOne<{ max: number | null }>()
        return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1
    }

    /** Active and total product counts per brand slug (optionally for a single brand). */
    private async productCounts(slug?: string): Promise<Map<string, ProductCounts>> {
        const query = this.products
            .createQueryBuilder('product')
            .select('product.brandSlug', 'slug')
            .addSelect('COUNT(*) FILTER (WHERE product.isActive)', 'active')
            .addSelect('COUNT(*)', 'total')
            .where('product.brandSlug IS NOT NULL')
            .groupBy('product.brandSlug')
        if (slug) query.andWhere('product.brandSlug = :slug', { slug })

        const rows = await query.getRawMany<{ slug: string; active: string; total: string }>()
        return new Map(
            rows.map((row) => [row.slug, { active: Number(row.active), total: Number(row.total) }]),
        )
    }
}

function toPublicDto(brand: Brand, counts: ProductCounts = NO_PRODUCTS): PublicBrandDto {
    return {
        slug: brand.slug,
        name: brand.name,
        logoUrl: brand.logoUrl,
        description: brand.description,
        productCount: counts.active,
    }
}

function toAdminDto(brand: Brand, counts: ProductCounts = NO_PRODUCTS): AdminBrandDto {
    return {
        ...toPublicDto(brand, counts),
        sortOrder: brand.sortOrder,
        isActive: brand.isActive,
        totalProductCount: counts.total,
        createdAt: brand.createdAt.toISOString(),
        updatedAt: brand.updatedAt.toISOString(),
    }
}
