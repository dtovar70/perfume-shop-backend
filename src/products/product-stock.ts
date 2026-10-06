import type { EntityManager } from 'typeorm'
import { ProductVariant } from './entities/product-variant.entity.js'
import { Product } from './entities/product.entity.js'

/**
 * Stock lives on the variants: every version (size, capacity...) has its own count, and
 * `products.stock` is their sum, rewritten in the same transaction that changes them so the
 * catalog can keep reading one column. A product without variants keeps its own count in
 * `products.stock` (the API and the admin allow that, although the storefront cannot sell it).
 *
 * Lock order, everywhere: product rows first, then their variant rows, both by id. Every writer
 * of variant stock holds the product row, so concurrent orders and admin edits never deadlock.
 */

/** Products and their variants, locked `FOR UPDATE` (variants in `sortOrder` order). */
export interface LockedStock {
    products: Map<string, Product>
    variants: Map<string, ProductVariant[]>
}

/** One place stock is counted: a variant, or a product without variants (`variantId` null). */
export interface StockUnit {
    productId: string
    variantId: string | null
    /** Units in stock when locked (never negative). */
    available: number
}

/** A quantity to take from (or give back to) one stock unit. */
export interface StockChange {
    productId: string
    variantId: string | null
    quantity: number
}

/** "Yara – 100 ml", or just the product name when there is no variant. */
export function stockItemName(productName: string, variantLabel?: string | null): string {
    return variantLabel ? `${productName} – ${variantLabel}` : productName
}

export function stockUnitKey(productId: string, variantId: string | null): string {
    return variantId ? `variant:${variantId}` : `product:${productId}`
}

/** Locks the given products and all their variants (see the lock order above). */
export function lockStock(
    manager: EntityManager,
    productIds: readonly string[],
): Promise<LockedStock> {
    return loadStock(manager, productIds, true)
}

/**
 * The same rows as `lockStock`, without locking them: for what is only shown (the admin order
 * page, a Telegram question). A decision that changes stock must use `lockStock`.
 */
export function readStock(
    manager: EntityManager,
    productIds: readonly string[],
): Promise<LockedStock> {
    return loadStock(manager, productIds, false)
}

async function loadStock(
    manager: EntityManager,
    productIds: readonly string[],
    lock: boolean,
): Promise<LockedStock> {
    const ids = [...new Set(productIds)].sort()
    if (!ids.length) return { products: new Map(), variants: new Map() }

    const productQuery = manager
        .createQueryBuilder(Product, 'product')
        .where('product.id IN (:...ids)', { ids })
        .orderBy('product.id', 'ASC')
    const variantQuery = manager
        .createQueryBuilder(ProductVariant, 'variant')
        .where('variant.productId IN (:...productIds)', { productIds: ids })
        .orderBy('variant.id', 'ASC')
    if (lock) {
        productQuery.setLock('pessimistic_write')
        variantQuery.setLock('pessimistic_write')
    }
    const products = await productQuery.getMany()
    const variants = await variantQuery.getMany()

    const byProduct = new Map<string, ProductVariant[]>()
    for (const variant of [...variants].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
    )) {
        byProduct.set(variant.productId, [...(byProduct.get(variant.productId) ?? []), variant])
    }
    return {
        products: new Map(products.map((product) => [product.id, product])),
        variants: byProduct,
    }
}

/**
 * Where an ordered line's stock is counted, or null when it cannot be: the product or the
 * variant was deleted, or a line without variant belongs to a product that has variants now.
 */
export function resolveStockUnit(
    locked: LockedStock,
    productId: string | null,
    variantId: string | null,
): StockUnit | null {
    const product = productId ? locked.products.get(productId) : undefined
    if (!product) return null
    const variants = locked.variants.get(product.id) ?? []
    if (variantId) {
        const variant = variants.find((candidate) => candidate.id === variantId)
        return variant
            ? { productId: product.id, variantId, available: Math.max(0, variant.stock) }
            : null
    }
    if (variants.length) return null
    return { productId: product.id, variantId: null, available: Math.max(0, product.stock) }
}

/**
 * Applies stock changes to rows the caller already locked, then rewrites the totals of the
 * products with variants. Taking never goes below 0 (the caller checked the locked counts).
 */
export async function changeStock(
    manager: EntityManager,
    direction: 'take' | 'give',
    changes: readonly StockChange[],
): Promise<void> {
    const totals = new Map<string, StockChange>()
    for (const change of changes) {
        if (change.quantity <= 0) continue
        const key = stockUnitKey(change.productId, change.variantId)
        const current = totals.get(key)
        if (current) current.quantity += change.quantity
        else totals.set(key, { ...change })
    }
    const sorted = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
    const withVariants = new Set<string>()

    for (const [, change] of sorted) {
        const table = change.variantId ? 'product_variants' : 'products'
        const id = change.variantId ?? change.productId
        if (direction === 'take') {
            await manager.query(
                `UPDATE "${table}" SET "stock" = "stock" - $1 WHERE "id" = $2 AND "stock" >= $1`,
                [change.quantity, id],
            )
        } else {
            await manager.query(`UPDATE "${table}" SET "stock" = "stock" + $1 WHERE "id" = $2`, [
                change.quantity,
                id,
            ])
        }
        if (change.variantId) withVariants.add(change.productId)
    }
    await syncProductStock(manager, [...withVariants])
}

/** Rewrites `products.stock` as the sum of its variants (products without variants untouched). */
export async function syncProductStock(
    manager: EntityManager,
    productIds: readonly string[],
): Promise<void> {
    for (const productId of [...new Set(productIds)].sort()) {
        await manager.query(
            `UPDATE "products" SET "stock" = (
                SELECT COALESCE(SUM(v."stock"), 0) FROM "product_variants" v WHERE v."product_id" = $1
            ) WHERE "id" = $1 AND EXISTS (SELECT 1 FROM "product_variants" WHERE "product_id" = $1)`,
            [productId],
        )
    }
}
