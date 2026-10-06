import type { EntityManager } from 'typeorm'
import type { ProductVariant } from './entities/product-variant.entity.js'
import type { Product } from './entities/product.entity.js'
import { changeStock, resolveStockUnit, stockItemName, type LockedStock } from './product-stock.js'

function locked(): LockedStock {
    const tee = { id: 'tee', stock: 5 } as Product
    const keychain = { id: 'key', stock: 2 } as Product
    return {
        products: new Map([
            [tee.id, tee],
            [keychain.id, keychain],
        ]),
        variants: new Map([
            [
                'tee',
                [
                    { id: 'tee-s', productId: 'tee', stock: 0 } as ProductVariant,
                    { id: 'tee-m', productId: 'tee', stock: 5 } as ProductVariant,
                ],
            ],
        ]),
    }
}

describe('stockItemName', () => {
    it('adds the variant label with an en dash', () => {
        expect(stockItemName('Yara X', 'Talla M')).toBe('Yara X – Talla M')
        expect(stockItemName('Asad', null)).toBe('Asad')
    })
})

describe('resolveStockUnit', () => {
    it('counts a variant line on the variant', () => {
        expect(resolveStockUnit(locked(), 'tee', 'tee-m')).toEqual({
            productId: 'tee',
            variantId: 'tee-m',
            available: 5,
        })
        expect(resolveStockUnit(locked(), 'tee', 'tee-s')?.available).toBe(0)
    })

    it('counts a product without variants on the product', () => {
        expect(resolveStockUnit(locked(), 'key', null)).toEqual({
            productId: 'key',
            variantId: null,
            available: 2,
        })
    })

    it('has no unit for deleted products or variants, nor for a variantless line of a product with variants', () => {
        expect(resolveStockUnit(locked(), null, 'tee-m')).toBeNull()
        expect(resolveStockUnit(locked(), 'gone', null)).toBeNull()
        expect(resolveStockUnit(locked(), 'tee', 'tee-xl')).toBeNull()
        expect(resolveStockUnit(locked(), 'tee', null)).toBeNull()
    })
})

describe('changeStock', () => {
    it('adds up changes per unit, updates in a fixed order and syncs the product totals', async () => {
        const query = vi.fn().mockResolvedValue([])
        await changeStock({ query } as unknown as EntityManager, 'take', [
            { productId: 'tee', variantId: 'tee-m', quantity: 2 },
            { productId: 'key', variantId: null, quantity: 1 },
            { productId: 'tee', variantId: 'tee-m', quantity: 1 },
            { productId: 'tee', variantId: 'tee-s', quantity: 0 },
        ])

        const calls = query.mock.calls as [string, unknown[]][]
        expect(calls.map(([sql, params]) => [sql.split(' SET ')[0], params])).toEqual([
            ['UPDATE "products"', [1, 'key']],
            ['UPDATE "product_variants"', [3, 'tee-m']],
            ['UPDATE "products"', ['tee']],
        ])
        expect(calls[1][0]).toContain('"stock" - $1')
        expect(calls[1][0]).toContain('"stock" >= $1')
        expect(calls[2][0]).toContain('SUM(v."stock")')
    })

    it('gives units back without a floor check', async () => {
        const query = vi.fn().mockResolvedValue([])
        await changeStock({ query } as unknown as EntityManager, 'give', [
            { productId: 'tee', variantId: 'tee-s', quantity: 4 },
        ])
        const [sql, params] = query.mock.calls[0] as [string, unknown[]]
        expect(sql).toBe('UPDATE "product_variants" SET "stock" = "stock" + $1 WHERE "id" = $2')
        expect(params).toEqual([4, 'tee-s'])
    })
})
