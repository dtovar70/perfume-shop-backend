import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, In, Repository, type EntityManager } from 'typeorm'
import { Brand } from '../brands/entities/brand.entity.js'
import { Category } from '../categories/entities/category.entity.js'
import { slugify } from '../common/utils/text.util.js'
import { dbConstraint, isDbError, omitUndefined } from '../database/db-errors.js'
import { newId } from '../database/id.js'
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.service.js'
import { buildSearchConditions, PRODUCT_ALIAS, type Condition } from './catalog-query.js'
import type { AdminProductQueryDto } from './dto/admin-product-query.dto.js'
import type { CreateProductDto, ProductVariantInputDto } from './dto/create-product.dto.js'
import type { UpdateProductDto } from './dto/update-product.dto.js'
import { ProductImage } from './entities/product-image.entity.js'
import { ProductVariant } from './entities/product-variant.entity.js'
import { Product } from './entities/product.entity.js'
import { computeDerivedFields } from './product-derived.js'
import { lockStock, syncProductStock } from './product-stock.js'
import { ProductRepository } from './product.repository.js'
import { toAdminProduct, type AdminProductDto, type Paginated } from './product.mapper.js'
import { PRODUCT_NOT_FOUND } from './products.constants.js'

/**
 * Rows for the variant list, in array order. Ids in `keepIds` (this product's current variants)
 * are kept so order lines and carts still point to them; anything else gets a new id.
 */
function variantRows(
    productId: string,
    variants: ProductVariantInputDto[],
    keepIds: ReadonlySet<string> = new Set(),
) {
    const used = new Set<string>()
    return variants.map((variant, index) => {
        const id =
            variant.id && keepIds.has(variant.id) && !used.has(variant.id) ? variant.id : newId()
        used.add(id)
        return {
            id,
            productId,
            label: variant.label,
            priceDelta: variant.priceDelta,
            volumeMl: variant.volumeMl ?? null,
            stock: variant.stock,
            sortOrder: index,
        }
    })
}

/** 409 of an update whose stock changed since the form was loaded (orders took or gave back units). */
export const STOCK_CHANGED = 'STOCK_CHANGED'

/** A stock count the admin edited, checked against the one the form was loaded with. */
interface StockEdit {
    /** Path of the edited field, e.g. `variants.0.stock` or `stock`. */
    field: string
    /** Count in the database (locked). */
    current: number
    /** What the admin typed. */
    stock: number
    /** What the form was loaded with; undefined when the client did not send it. */
    expected: number | undefined
}

/**
 * The count to store for one stock field the admin may have edited, or why it cannot be stored.
 * A value equal to the loaded one means "not touched": the database count is kept, so editing
 * only the name or the price never fights with the orders taking units meanwhile.
 */
function resolveStockEdit(edit: StockEdit): number | 'missing' | 'changed' {
    if (edit.expected === undefined) {
        // An old client: writing the same count is harmless, anything else could overwrite.
        return edit.stock === edit.current ? edit.current : 'missing'
    }
    if (edit.stock === edit.expected) return edit.current
    return edit.current === edit.expected ? edit.stock : 'changed'
}

/** With variants, the product's stock is their sum; otherwise the given count. */
function productStock(variants: ProductVariantInputDto[] | undefined, stock: number | undefined) {
    return variants?.length
        ? variants.reduce((sum, variant) => sum + variant.stock, 0)
        : (stock ?? 0)
}

@Injectable()
export class AdminProductsService {
    private readonly logger = new Logger(AdminProductsService.name)

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(Product) private readonly products: Repository<Product>,
        @InjectRepository(Category) private readonly categories: Repository<Category>,
        @InjectRepository(Brand) private readonly brands: Repository<Brand>,
        @InjectRepository(ProductImage) private readonly images: Repository<ProductImage>,
        private readonly productReader: ProductRepository,
        @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    ) {}

    async list(query: AdminProductQueryDto): Promise<Paginated<AdminProductDto>> {
        const conditions: Condition[] = [...buildSearchConditions(query.search)]
        if (query.category) {
            conditions.push({
                clause: `${PRODUCT_ALIAS}.categorySlug = :category`,
                params: { category: query.category },
            })
        }
        if (query.isActive !== undefined) {
            conditions.push({
                clause: `${PRODUCT_ALIAS}.isActive = :isActive`,
                params: { isActive: query.isActive },
            })
        }

        const page = await this.productReader.paginate(
            conditions,
            [
                [`${PRODUCT_ALIAS}.updatedAt`, 'DESC'],
                [`${PRODUCT_ALIAS}.id`, 'ASC'],
            ],
            query.page,
            query.pageSize,
        )
        return { ...page, items: page.items.map(toAdminProduct) }
    }

    async get(id: string): Promise<AdminProductDto> {
        return toAdminProduct(await this.load(id))
    }

    async create(dto: CreateProductDto): Promise<AdminProductDto> {
        await this.assertCategoryExists(dto.categorySlug)
        const brandName = await this.brandName(dto.brandSlug)
        const slug = dto.slug ?? slugify(dto.name)
        if (!slug) {
            throw new BadRequestException('No pudimos generar un slug a partir del nombre.')
        }
        const tags = dto.tags ?? []
        const perfume = {
            brandSlug: dto.brandSlug ?? null,
            gender: dto.gender ?? 'unisex',
            concentration: dto.concentration ?? null,
            volumeMl: dto.volumeMl ?? null,
            notesTop: dto.notesTop ?? [],
            notesHeart: dto.notesHeart ?? [],
            notesBase: dto.notesBase ?? [],
            olfactoryFamily: dto.olfactoryFamily ?? null,
            isFeatured: dto.isFeatured ?? false,
            sku: dto.sku ?? null,
        } satisfies Partial<Product>
        this.assertCompareAtPrice(dto.price, dto.compareAtPrice)

        const id = newId()
        try {
            await this.dataSource.transaction(async (manager) => {
                await manager.insert(Product, {
                    id,
                    slug,
                    name: dto.name,
                    categorySlug: dto.categorySlug,
                    price: dto.price,
                    compareAtPrice: dto.compareAtPrice ?? null,
                    ...perfume,
                    description: dto.description,
                    highlights: dto.highlights ?? [],
                    tags,
                    rating: dto.rating ?? 0,
                    reviewCount: dto.reviewCount ?? 0,
                    stock: productStock(dto.variants, dto.stock),
                    isActive: dto.isActive ?? true,
                    ...computeDerivedFields({ ...dto, ...perfume, tags, brandName }),
                })
                const variants = variantRows(id, dto.variants ?? [])
                if (variants.length) await manager.insert(ProductVariant, variants)
            })
        } catch (error) {
            this.rethrowConstraintError(error, slug, perfume.sku)
        }
        return this.get(id)
    }

    async update(id: string, dto: UpdateProductDto): Promise<AdminProductDto> {
        const current = await this.products.findOneBy({ id })
        if (!current) throw new NotFoundException(PRODUCT_NOT_FOUND)
        if (dto.categorySlug) await this.assertCategoryExists(dto.categorySlug)
        const brandSlug = dto.brandSlug === undefined ? current.brandSlug : dto.brandSlug
        const brandName = await this.brandName(brandSlug)

        const merged = {
            name: dto.name ?? current.name,
            description: dto.description ?? current.description,
            tags: dto.tags ?? current.tags,
            brandName,
            gender: dto.gender ?? current.gender,
            concentration:
                dto.concentration === undefined ? current.concentration : dto.concentration,
            olfactoryFamily:
                dto.olfactoryFamily === undefined ? current.olfactoryFamily : dto.olfactoryFamily,
            notesTop: dto.notesTop ?? current.notesTop,
            notesHeart: dto.notesHeart ?? current.notesHeart,
            notesBase: dto.notesBase ?? current.notesBase,
            isFeatured: dto.isFeatured ?? current.isFeatured,
        }
        const price = dto.price ?? current.price
        const compareAtPrice =
            dto.compareAtPrice === undefined ? current.compareAtPrice : dto.compareAtPrice
        this.assertCompareAtPrice(price, compareAtPrice)

        const { variants, expectedStock, ...fields } = dto
        try {
            // Replacing variants and updating the product must succeed or fail together.
            await this.dataSource.transaction(async (manager) => {
                // Same lock order as the orders (the product, then its variants by id): the
                // counts compared below cannot move until this transaction ends.
                const locked = await lockStock(manager, [id])
                const product = locked.products.get(id)
                if (!product) throw new NotFoundException(PRODUCT_NOT_FOUND)
                const currentVariants = locked.variants.get(id) ?? []
                const rows = variants
                    ? variantRows(id, variants, new Set(currentVariants.map((v) => v.id)))
                    : undefined
                this.applyStockEdits(
                    product,
                    currentVariants,
                    variants && rows ? { inputs: variants, rows } : undefined,
                    fields,
                    expectedStock,
                )

                await manager.update(
                    Product,
                    { id },
                    {
                        ...omitUndefined(fields),
                        ...computeDerivedFields(merged),
                    },
                )
                if (rows) await this.replaceVariants(manager, currentVariants, rows)
                // Also after a plain `stock` edit: with variants it is always their sum.
                await syncProductStock(manager, [id])
            })
        } catch (error) {
            this.rethrowConstraintError(
                error,
                dto.slug ?? current.slug,
                dto.sku === undefined ? current.sku : dto.sku,
            )
        }
        return this.get(id)
    }

    async setActive(id: string, isActive?: boolean): Promise<AdminProductDto> {
        const current = await this.products.findOne({
            where: { id },
            select: { id: true, isActive: true },
        })
        if (!current) throw new NotFoundException(PRODUCT_NOT_FOUND)

        await this.products.update({ id }, { isActive: isActive ?? !current.isActive })
        return this.get(id)
    }

    async remove(id: string): Promise<void> {
        const images = await this.images.find({
            where: { productId: id },
            select: { publicId: true },
        })
        // Variants and images are removed by ON DELETE CASCADE.
        const result = await this.products.delete({ id })
        if (!result.affected) throw new NotFoundException(PRODUCT_NOT_FOUND)

        // Files are removed after the rows are gone; a failure only leaves an orphan file.
        await Promise.all(
            images.map(({ publicId }) =>
                this.storage.delete(publicId).catch((error: unknown) => {
                    this.logger.warn(
                        `Could not delete stored image "${publicId}": ${String(error)}`,
                    )
                }),
            ),
        )
    }

    /**
     * Checks every stock count the admin edited against the one the form was loaded with, on
     * rows `lockStock` holds, and keeps the database count where the admin did not edit it
     * (rewrites `rows[].stock` and `fields.stock` in place). 409 `STOCK_CHANGED` with the
     * current counts when orders moved an edited one; 400 when an edit lacks its loaded count.
     */
    private applyStockEdits(
        product: Product,
        currentVariants: readonly ProductVariant[],
        variants:
            { inputs: ProductVariantInputDto[]; rows: { id: string; stock: number }[] } | undefined,
        fields: { stock?: number },
        expectedStock: number | undefined,
    ): void {
        const currentById = new Map(currentVariants.map((variant) => [variant.id, variant.stock]))
        const missing: string[] = []
        let changed = false
        const resolve = (edit: StockEdit): number => {
            const result = resolveStockEdit(edit)
            if (result === 'missing') missing.push(edit.field.replace(/stock$/, 'expectedStock'))
            else if (result === 'changed') changed = true
            return typeof result === 'number' ? result : edit.current
        }

        variants?.rows.forEach((row, index) => {
            const current = currentById.get(row.id)
            const input = variants.inputs[index]
            // New variants have no loaded count: theirs is simply written.
            if (current === undefined || !input) return
            row.stock = resolve({
                field: `variants.${index}.stock`,
                current,
                stock: input.stock,
                expected: input.expectedStock,
            })
        })

        if (fields.stock !== undefined) {
            const endsWithVariants = variants
                ? variants.rows.length > 0
                : currentVariants.length > 0
            if (endsWithVariants) {
                // With variants the product's stock is their sum (`syncProductStock`).
                delete fields.stock
            } else {
                fields.stock = resolve({
                    field: 'stock',
                    current: product.stock,
                    stock: fields.stock,
                    expected: expectedStock,
                })
            }
        }

        if (changed) {
            throw new ConflictException({
                statusCode: 409,
                error: 'Conflict',
                code: STOCK_CHANGED,
                message:
                    'El stock cambió mientras editabas (entraron pedidos). Recarga para ver el valor actual.',
                stock: product.stock,
                variants: currentVariants.map(({ id, label, stock }) => ({ id, label, stock })),
            })
        }
        if (missing.length) {
            throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                message:
                    'Para cambiar el stock recarga el producto: falta el stock que tenía al abrir el formulario.',
                details: missing.map((field) => ({
                    field,
                    errors: ['Falta el stock que tenía al abrir el formulario.'],
                })),
            })
        }
    }

    /**
     * Replaces the variant list (order = array order), keeping the ids of the variants that
     * stay. `current` are this product's variants, locked by `lockStock` with the product.
     */
    private async replaceVariants(
        manager: EntityManager,
        current: readonly ProductVariant[],
        rows: ReturnType<typeof variantRows>,
    ): Promise<void> {
        const kept = new Set(rows.map(({ id }) => id))
        const removed = current.map(({ id }) => id).filter((id) => !kept.has(id))
        if (removed.length) await manager.delete(ProductVariant, { id: In(removed) })
        if (rows.length) await manager.upsert(ProductVariant, rows, ['id'])
    }

    private async load(id: string): Promise<Product> {
        const product = await this.productReader.findOneWithRelations({ id })
        if (!product) throw new NotFoundException(PRODUCT_NOT_FOUND)
        return product
    }

    private async assertCategoryExists(slug: string): Promise<void> {
        const exists = await this.categories.existsBy({ slug })
        if (!exists) {
            throw new BadRequestException(`La categoría "${slug}" no existe.`)
        }
    }

    /** The brand's name for the search text (400 when the slug is unknown). */
    private async brandName(slug: string | null | undefined): Promise<string | null> {
        if (!slug) return null
        const brand = await this.brands.findOne({ where: { slug }, select: { name: true } })
        if (!brand) throw new BadRequestException(`La marca "${slug}" no existe.`)
        return brand.name
    }

    private assertCompareAtPrice(price: number, compareAtPrice?: number | null): void {
        if (compareAtPrice !== undefined && compareAtPrice !== null && compareAtPrice <= price) {
            throw new BadRequestException(
                'El precio anterior (compareAtPrice) debe ser mayor que el precio actual.',
            )
        }
    }

    private rethrowConstraintError(error: unknown, slug: string, sku: string | null): never {
        if (isDbError(error, '23505')) {
            if (sku && dbConstraint(error) === 'products_sku_key') {
                throw new ConflictException(`Ya existe un producto con el SKU "${sku}".`)
            }
            throw new ConflictException(`Ya existe un producto con el slug "${slug}".`)
        }
        if (isDbError(error, '23503')) {
            throw new BadRequestException(
                dbConstraint(error) === 'products_brand_slug_fkey'
                    ? 'La marca indicada no existe.'
                    : 'La categoría indicada no existe.',
            )
        }
        throw error
    }
}
