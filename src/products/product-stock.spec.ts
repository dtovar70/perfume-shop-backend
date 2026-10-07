import type { EntityManager } from 'typeorm'
import type { ProductVariant } from './entities/product-variant.entity.js'
import type { Product } from './entities/product.entity.js'
import { changeStock, resolveStockUnit, stockItemName, type LockedStock } from './product-stock.js'

function locked(): LockedStock {
    const asad = { id: 'asad', stock: 5 } as Product
    const giftSet = { id: 'key', stock: 2 } as Product
    return {
        products: new Map([
            [asad.id, asad],
            [giftSet.id, giftSet],
        ]),
        variants: new Map([
            [
                'asad',
                [
                    { id: 'asad-50ml', productId: 'asad', stock: 0 } as ProductVariant,
                    { id: 'asad-100ml', productId: 'asad', stock: 5 } as ProductVariant,
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
        expect(resolveStockUnit(locked(), 'asad', 'asad-100ml')).toEqual({
            productId: 'asad',
            variantId: 'asad-100ml',
            available: 5,
        })
        expect(resolveStockUnit(locked(), 'asad', 'asad-50ml')?.available).toBe(0)
    })

    it('counts a product without variants on the product', () => {
        expect(resolveStockUnit(locked(), 'key', null)).toEqual({
            productId: 'key',
            variantId: null,
            available: 2,
        })
    })

    it('has no unit for deleted products or variants, nor for a variantless line of a product with variants', () => {
        expect(resolveStockUnit(locked(), null, 'asad-100ml')).toBeNull()
        expect(resolveStockUnit(locked(), 'gone', null)).toBeNull()
        expect(resolveStockUnit(locked(), 'asad', 'asad-200ml')).toBeNull()
        expect(resolveStockUnit(locked(), 'asad', null)).toBeNull()
    })
})

describe('changeStock', () => {
    it('adds up changes per unit, updates in a fixed order and syncs the product totals', async () => {
        const query = vi.fn().mockResolvedValue([])
        await changeStock({ query } as unknown as EntityManager, 'take', [
            { productId: 'asad', variantId: 'asad-100ml', quantity: 2 },
            { productId: 'key', variantId: null, quantity: 1 },
            { productId: 'asad', variantId: 'asad-100ml', quantity: 1 },
            { productId: 'asad', variantId: 'asad-50ml', quantity: 0 },
        ])

        const calls = query.mock.calls as [string, unknown[]][]
        expect(calls.map(([sql, params]) => [sql.split(' SET ')[0], params])).toEqual([
            ['UPDATE "products"', [1, 'key']],
            ['UPDATE "product_variants"', [3, 'asad-100ml']],
            ['UPDATE "products"', ['asad']],
        ])
        const [, [takeSql] = [''], [syncSql] = ['']] = calls
        expect(takeSql).toContain('"stock" - $1')
        expect(takeSql).toContain('"stock" >= $1')
        expect(syncSql).toContain('SUM(v."stock")')
    })

    it('gives units back without a floor check', async () => {
        const query = vi.fn().mockResolvedValue([])
        await changeStock({ query } as unknown as EntityManager, 'give', [
            { productId: 'asad', variantId: 'asad-50ml', quantity: 4 },
        ])
        const [sql, params] = query.mock.calls[0] as [string, unknown[]]
        expect(sql).toBe('UPDATE "product_variants" SET "stock" = "stock" + $1 WHERE "id" = $2')
        expect(params).toEqual([4, 'asad-50ml'])
    })
})
