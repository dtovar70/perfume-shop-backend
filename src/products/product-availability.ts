/** A cart line to check: a product and, when it has versions, the chosen one. */
export interface AvailabilityRequestItem {
    productId: string
    variantId?: string
}

/**
 * Live availability of one cart line, in request order. Matches `CartAvailability` in
 * frontend-perfume-shop/src/@types/cart.ts.
 */
export interface AvailabilityDto {
    productId: string
    variantId: string | null
    /** Units left of the variant (or of the product without variants); never negative. */
    stock: number
    isActive: boolean
    /**
     * False when the product or the variant is gone, the variant belongs to another product,
     * or a product with variants was asked without one (checkout refuses all of these).
     */
    exists: boolean
}

export interface AvailabilityProductRow {
    id: string
    stock: number
    isActive: boolean
}

export interface AvailabilityVariantRow {
    id: string
    productId: string
    stock: number
}

/**
 * Resolves each requested line against the product and variant rows, with the same rules the
 * checkout applies (see `OrdersService.priceLines`): stock per variant, or per product when it
 * has no variants.
 */
export function resolveAvailability(
    items: readonly AvailabilityRequestItem[],
    products: readonly AvailabilityProductRow[],
    variants: readonly AvailabilityVariantRow[],
): AvailabilityDto[] {
    const productsById = new Map(products.map((product) => [product.id, product]))
    const variantsByProduct = new Map<string, AvailabilityVariantRow[]>()
    for (const variant of variants) {
        const list = variantsByProduct.get(variant.productId) ?? []
        list.push(variant)
        variantsByProduct.set(variant.productId, list)
    }

    return items.map(({ productId, variantId }) => {
        const product = productsById.get(productId)
        const missing: AvailabilityDto = {
            productId,
            variantId: variantId ?? null,
            stock: 0,
            isActive: product?.isActive ?? false,
            exists: false,
        }
        if (!product) return missing
        const own = variantsByProduct.get(product.id) ?? []
        if (variantId === undefined) {
            if (own.length) return missing
            return { ...missing, stock: Math.max(0, product.stock), exists: true }
        }
        const variant = own.find((candidate) => candidate.id === variantId)
        if (!variant) return missing
        return { ...missing, stock: Math.max(0, variant.stock), exists: true }
    })
}
