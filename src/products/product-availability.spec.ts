import { resolveAvailability } from './product-availability.js'

const PRODUCTS = [
    { id: 'khamrah', stock: 8, isActive: true },
    { id: 'key', stock: 3, isActive: true },
    { id: 'off', stock: 9, isActive: false },
    { id: 'neg', stock: -2, isActive: true },
]
const VARIANTS = [
    { id: 'v-11', productId: 'khamrah', stock: 3 },
    { id: 'v-15', productId: 'khamrah', stock: 5 },
    { id: 'v-off', productId: 'off', stock: 0 },
]

describe('resolveAvailability', () => {
    it('reads the stock of the chosen variant', () => {
        expect(
            resolveAvailability([{ productId: 'khamrah', variantId: 'v-15' }], PRODUCTS, VARIANTS),
        ).toEqual([
            { productId: 'khamrah', variantId: 'v-15', stock: 5, isActive: true, exists: true },
        ])
    })

    it('reads the product stock when the product has no variants', () => {
        expect(resolveAvailability([{ productId: 'key' }], PRODUCTS, VARIANTS)).toEqual([
            { productId: 'key', variantId: null, stock: 3, isActive: true, exists: true },
        ])
    })

    it('keeps the request order and repeats duplicated lines', () => {
        const result = resolveAvailability(
            [
                { productId: 'khamrah', variantId: 'v-11' },
                { productId: 'key' },
                { productId: 'khamrah', variantId: 'v-11' },
            ],
            PRODUCTS,
            VARIANTS,
        )
        expect(result.map((item) => [item.productId, item.variantId, item.stock])).toEqual([
            ['khamrah', 'v-11', 3],
            ['key', null, 3],
            ['khamrah', 'v-11', 3],
        ])
    })

    it('reports inactive products with their stock', () => {
        expect(
            resolveAvailability([{ productId: 'off', variantId: 'v-off' }], PRODUCTS, VARIANTS)[0],
        ).toMatchObject({ isActive: false, exists: true, stock: 0 })
    })

    it('marks unknown products, unknown or foreign variants and missing choices as not existing', () => {
        const result = resolveAvailability(
            [
                { productId: 'nope', variantId: 'v-11' },
                { productId: 'khamrah', variantId: 'gone' },
                { productId: 'key', variantId: 'v-11' },
                { productId: 'khamrah' },
            ],
            PRODUCTS,
            VARIANTS,
        )
        expect(result.map((item) => [item.exists, item.stock, item.isActive])).toEqual([
            [false, 0, false],
            [false, 0, true],
            [false, 0, true],
            [false, 0, true],
        ])
    })

    it('never reports negative stock', () => {
        expect(resolveAvailability([{ productId: 'neg' }], PRODUCTS, [])[0]?.stock).toBe(0)
    })
})
