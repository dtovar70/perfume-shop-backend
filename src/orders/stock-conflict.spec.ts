import type { ProductVariant } from '../products/entities/product-variant.entity.js'
import type { Product } from '../products/entities/product.entity.js'
import type { LockedStock } from '../products/product-stock.js'
import type { StockConflict, StockConflictLine } from './entities/order.entity.js'
import { liveStockConflict, stockConflictProductIds } from './stock-conflict.js'

function stock(mint: number, keychain = 0): LockedStock {
    const acrylic = { id: 'key', stock: mint } as Product
    const plain = { id: 'plain', stock: keychain } as Product
    return {
        products: new Map([
            [acrylic.id, acrylic],
            [plain.id, plain],
        ]),
        variants: new Map([
            ['key', [{ id: 'key-mint', productId: 'key', stock: mint } as ProductVariant]],
        ]),
    }
}

function conflict(lines: Partial<StockConflictLine>[], resolvedAt: string | null = null) {
    return {
        detectedAt: '2026-09-01T12:00:00.000Z',
        lines: lines.map((line) => ({
            productId: 'key',
            variantId: 'key-mint',
            productName: 'Asad Edición',
            variantLabel: 'Menta',
            requested: 1,
            available: 0,
            reserved: 0,
            ...line,
        })),
        resolvedAt,
        resolvedById: null,
    } satisfies StockConflict
}

describe('liveStockConflict', () => {
    it('is no longer short once the variant was restocked', () => {
        const live = liveStockConflict(conflict([{}]), stock(2))
        expect(live.stillShort).toBe(false)
        expect(live.lines[0]).toMatchObject({ available: 2, reserved: 0, stillShort: false })
    })

    it('stays short with the current numbers', () => {
        const live = liveStockConflict(conflict([{}]), stock(0))
        expect(live.stillShort).toBe(true)
        expect(live.lines[0]).toMatchObject({ available: 0, stillShort: true })
    })

    it('stays short after a partial restock, with what is there now', () => {
        const live = liveStockConflict(conflict([{ requested: 2 }]), stock(1))
        expect(live.stillShort).toBe(true)
        expect(live.lines[0]).toMatchObject({ requested: 2, available: 1, stillShort: true })
    })

    it('only needs the units the order does not hold yet', () => {
        const live = liveStockConflict(conflict([{ requested: 3, reserved: 2 }]), stock(1))
        expect(live.stillShort).toBe(false)
    })

    it('reads a line without variants on its product', () => {
        const line = { productId: 'plain', variantId: null, variantLabel: null }
        expect(liveStockConflict(conflict([line]), stock(0, 1)).stillShort).toBe(false)
        expect(liveStockConflict(conflict([line]), stock(0, 0)).stillShort).toBe(true)
    })

    it('counts nothing for a deleted variant or product', () => {
        const live = liveStockConflict(
            conflict([{ variantId: 'gone' }, { productId: null, variantId: null }]),
            stock(5),
        )
        expect(live.lines.map((line) => [line.available, line.stillShort])).toEqual([
            [0, true],
            [0, true],
        ])
    })

    it('flags each line on its own', () => {
        const live = liveStockConflict(
            conflict([{}, { productId: 'plain', variantId: null, variantLabel: null }]),
            stock(1, 0),
        )
        expect(live.lines.map((line) => line.stillShort)).toEqual([false, true])
        expect(live.stillShort).toBe(true)
    })

    it('keeps a resolved conflict as recorded', () => {
        const resolved = conflict([{ available: 0, reserved: 0 }], '2026-09-02T12:00:00.000Z')
        const live = liveStockConflict(resolved, stock(5))
        expect(live.stillShort).toBe(false)
        expect(live.lines[0]).toMatchObject({ available: 0, stillShort: false })
    })
})

describe('stockConflictProductIds', () => {
    it('skips deleted products', () => {
        expect(
            stockConflictProductIds(conflict([{}, { productId: null, variantId: null }])),
        ).toEqual(['key'])
    })
})
