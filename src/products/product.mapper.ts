import type { Product } from './entities/product.entity.js'
import type { ProductGender, ProductTag } from './products.constants.js'

/** A product loaded with its `brand`, `variants` and `images` relations (see ProductRepository). */
export type ProductWithRelations = Product

export interface ProductVariantDto {
    id: string
    label: string
    priceDelta: number
    /** Bottle size of this version, in ml; null when the variant is not a size. */
    volumeMl: number | null
    /** Units of this version in stock (the product's `stock` is the sum of its variants). */
    stock: number
}

export interface ProductBrandDto {
    slug: string
    name: string
    logoUrl: string | null
}

/** Olfactory pyramid. */
export interface ProductNotesDto {
    top: string[]
    heart: string[]
    base: string[]
}

export interface ProductImageDto {
    id: string
    url: string
    alt: string | null
}

/** Matches `Product` in frontend-perfume-shop/src/@types/product.ts, plus `images`. */
export interface PublicProductDto {
    id: string
    slug: string
    name: string
    category: string
    price: number
    compareAtPrice?: number
    brand: ProductBrandDto | null
    gender: ProductGender
    concentration: string | null
    volumeMl: number | null
    notes: ProductNotesDto
    olfactoryFamily: string | null
    isFeatured: boolean
    sku: string | null
    description: string
    highlights: string[]
    variants: ProductVariantDto[]
    tags: ProductTag[]
    stock: number
    createdAt: string
    images: ProductImageDto[]
}

export interface AdminProductDto extends PublicProductDto {
    isActive: boolean
    updatedAt: string
}

export interface Paginated<T> {
    items: T[]
    page: number
    pageSize: number
    total: number
    totalPages: number
}

export function toPublicProduct(product: ProductWithRelations): PublicProductDto {
    return {
        id: product.id,
        slug: product.slug,
        name: product.name,
        category: product.categorySlug,
        price: product.price,
        ...(product.compareAtPrice !== null && { compareAtPrice: product.compareAtPrice }),
        brand: product.brand
            ? { slug: product.brand.slug, name: product.brand.name, logoUrl: product.brand.logoUrl }
            : null,
        gender: product.gender,
        concentration: product.concentration,
        volumeMl: product.volumeMl,
        notes: { top: product.notesTop, heart: product.notesHeart, base: product.notesBase },
        olfactoryFamily: product.olfactoryFamily,
        isFeatured: product.isFeatured,
        sku: product.sku,
        description: product.description,
        highlights: product.highlights,
        variants: product.variants.map((variant) => ({
            id: variant.id,
            label: variant.label,
            priceDelta: variant.priceDelta,
            volumeMl: variant.volumeMl,
            stock: variant.stock,
        })),
        tags: product.tags as ProductTag[],
        stock: product.stock,
        createdAt: product.createdAt.toISOString(),
        images: product.images.map((image) => ({ id: image.id, url: image.url, alt: image.alt })),
    }
}

export function toAdminProduct(product: ProductWithRelations): AdminProductDto {
    return {
        ...toPublicProduct(product),
        isActive: product.isActive,
        updatedAt: product.updatedAt.toISOString(),
    }
}
