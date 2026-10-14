import { BadRequestException, ConflictException } from '@nestjs/common'
import type { DataSource, Repository } from 'typeorm'
import type { Brand } from '../brands/entities/brand.entity.js'
import type { Category } from '../categories/entities/category.entity.js'
import type { StorageService } from '../storage/storage.service.js'
import { AdminProductsService, STOCK_CHANGED } from './admin-products.service.js'
import type { CreateProductDto } from './dto/create-product.dto.js'
import type { ProductImage } from './entities/product-image.entity.js'
import { ProductVariant } from './entities/product-variant.entity.js'
import { Product } from './entities/product.entity.js'
import type { ProductRepository } from './product.repository.js'

interface StoredStock {
    product: { id: string; stock: number }
    variants: { id: string; productId: string; label: string; stock: number; sortOrder: number }[]
}

/** p1 with three sizes (S: 2, M: 4, L: 0), as `lockStock` reads them. */
function storedVariants(): StoredStock {
    const variants = [
        { id: 'v-s', label: 'S', stock: 2 },
        { id: 'v-m', label: 'M', stock: 4 },
        { id: 'v-l', label: 'L', stock: 0 },
    ].map((variant, sortOrder) => ({ ...variant, productId: 'p1', sortOrder }))
    return { product: { id: 'p1', stock: 6 }, variants }
}

function setup(stored: StoredStock = storedVariants()) {
    const builder = (rows: unknown[]) => {
        const query = {
            where: vi.fn(() => query),
            orderBy: vi.fn(() => query),
            setLock: vi.fn(() => query),
            getMany: vi.fn().mockResolvedValue(rows),
        }
        return query
    }
    const manager = {
        insert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        upsert: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
        createQueryBuilder: vi.fn((entity: unknown) =>
            builder(entity === Product ? [stored.product] : stored.variants),
        ),
    }
    const dataSource = {
        transaction: vi.fn((work: (value: typeof manager) => Promise<unknown>) => work(manager)),
    }
    const products = {
        findOneBy: vi.fn().mockResolvedValue({
            id: 'p1',
            slug: 'yara',
            name: 'Yara',
            description: '',
            tags: [],
            brandSlug: null,
            notesTop: [],
            notesHeart: [],
            notesBase: [],
            price: 20,
            compareAtPrice: null,
        }),
    }
    const categories = { existsBy: vi.fn().mockResolvedValue(true) }
    const reader = {
        findOneWithRelations: vi.fn().mockResolvedValue({
            id: 'p1',
            variants: [],
            images: [],
            tags: [],
            compareAtPrice: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        }),
    }
    const service = new AdminProductsService(
        dataSource as unknown as DataSource,
        products as unknown as Repository<Product>,
        categories as unknown as Repository<Category>,
        {} as Repository<Brand>,
        {} as Repository<ProductImage>,
        reader as unknown as ProductRepository,
        {} as StorageService,
    )
    return { service, manager }
}

const VARIANT = { priceDelta: 0 }

describe('AdminProductsService stock', () => {
    it('creates a product whose stock is the sum of its variants', async () => {
        const { service, manager } = setup()
        await service.create({
            name: 'Yara',
            categorySlug: 'europeos',
            price: 20,
            description: '',
            stock: 99,
            variants: [
                { ...VARIANT, label: 'S', stock: 2 },
                { ...VARIANT, label: 'M', stock: 3 },
            ],
        } as CreateProductDto)

        const [, product] = manager.insert.mock.calls.find(([entity]) => entity === Product)!
        expect(product).toMatchObject({ stock: 5 })
        const [, variants] = manager.insert.mock.calls.find(
            ([entity]) => entity === ProductVariant,
        )!
        expect(variants).toMatchObject([
            { label: 'S', stock: 2, sortOrder: 0 },
            { label: 'M', stock: 3, sortOrder: 1 },
        ])
    })

    it('keeps its own stock for a product without variants', async () => {
        const { service, manager } = setup()
        await service.create({
            name: 'Asad',
            categorySlug: 'arabes',
            price: 4,
            description: '',
            stock: 7,
        } as CreateProductDto)
        const [, product] = manager.insert.mock.calls.find(([entity]) => entity === Product)!
        expect(product).toMatchObject({ stock: 7 })
    })

    it('keeps the ids of the variants that stay, removes the rest and syncs the total', async () => {
        const { service, manager } = setup()
        await service.update('p1', {
            variants: [
                { ...VARIANT, id: 'v-m', label: 'M', stock: 4 },
                { ...VARIANT, label: 'XL', stock: 1 },
                // Not a variant of this product (or repeated): gets a new id.
                { ...VARIANT, id: 'other-product', label: 'XS', stock: 0 },
                { ...VARIANT, id: 'v-m', label: 'M bis', stock: 0 },
            ],
        })

        const [, deleted] = manager.delete.mock.calls[0] as [unknown, { id: { value: string[] } }]
        expect(deleted.id.value).toEqual(['v-s', 'v-l'])
        const [entity, rows, conflict] = manager.upsert.mock.calls[0] as [
            unknown,
            { id: string; label: string; stock: number; sortOrder: number }[],
            string[],
        ]
        expect(entity).toBe(ProductVariant)
        expect(conflict).toEqual(['id'])
        expect(rows[0]).toMatchObject({ id: 'v-m', label: 'M', stock: 4, sortOrder: 0 })
        expect(rows.slice(1).map((row) => row.id)).not.toContain('v-m')
        expect(rows.slice(1).map((row) => row.id)).not.toContain('other-product')

        const [sync] = manager.query.mock.calls.at(-1) as [string, unknown[]]
        expect(sync).toContain('SUM(v."stock")')
    })

    it('locks the product and its variants before writing', async () => {
        const { service, manager } = setup()
        await service.update('p1', { name: 'Yara' })

        const locks = manager.createQueryBuilder.mock.results.map(
            ({ value }) => (value as { setLock: ReturnType<typeof vi.fn> }).setLock,
        )
        expect(locks.map((setLock) => setLock.mock.calls[0])).toEqual([
            ['pessimistic_write'],
            ['pessimistic_write'],
        ])
        expect(manager.createQueryBuilder.mock.calls.map(([entity]) => entity)).toEqual([
            Product,
            ProductVariant,
        ])
    })
})

describe('AdminProductsService stock edits (optimistic concurrency)', () => {
    type VariantRow = { id: string; stock: number }
    const upserted = (manager: ReturnType<typeof setup>['manager']) =>
        (manager.upsert.mock.calls[0] as [unknown, VariantRow[]])[1]
    const loaded = (stock: number) => ({ stock, expectedStock: stock })

    it('keeps the current stock when the admin did not change it (orders took units meanwhile)', async () => {
        // The form was loaded with S: 5 and M: 6; orders left S: 2 and M: 4.
        const { service, manager } = setup()
        await service.update('p1', {
            name: 'Yara edición',
            variants: [
                { ...VARIANT, id: 'v-s', label: 'S', ...loaded(5) },
                { ...VARIANT, id: 'v-m', label: 'M', ...loaded(6) },
                { ...VARIANT, id: 'v-l', label: 'L', ...loaded(0) },
            ],
        })

        expect(upserted(manager).map(({ id, stock }) => [id, stock])).toEqual([
            ['v-s', 2],
            ['v-m', 4],
            ['v-l', 0],
        ])
        const [sync] = manager.query.mock.calls.at(-1) as [string, unknown[]]
        expect(sync).toContain('SUM(v."stock")')
    })

    it('writes a changed stock when the loaded count still matches', async () => {
        const { service, manager } = setup()
        await service.update('p1', {
            variants: [
                { ...VARIANT, id: 'v-s', label: 'S', stock: 10, expectedStock: 2 },
                { ...VARIANT, id: 'v-m', label: 'M', ...loaded(4) },
                { ...VARIANT, label: 'XL', stock: 3 },
            ],
        })

        const rows = upserted(manager)
        expect(rows.map(({ stock }) => stock)).toEqual([10, 4, 3])
        expect(rows[0]).toMatchObject({ id: 'v-s' })
    })

    it('rejects a changed stock whose loaded count is stale with 409 STOCK_CHANGED', async () => {
        const { service, manager } = setup()
        const error = await service
            .update('p1', {
                variants: [
                    // Loaded at 5, orders took 3 (now 2): saving 10 would oversell.
                    { ...VARIANT, id: 'v-s', label: 'S', stock: 10, expectedStock: 5 },
                    { ...VARIANT, id: 'v-m', label: 'M', ...loaded(4) },
                ],
            })
            .catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(ConflictException)
        expect((error as ConflictException).getResponse()).toMatchObject({
            statusCode: 409,
            code: STOCK_CHANGED,
            message: expect.stringContaining('El stock cambió mientras editabas') as unknown,
            stock: 6,
            variants: [
                { id: 'v-s', label: 'S', stock: 2 },
                { id: 'v-m', label: 'M', stock: 4 },
                { id: 'v-l', label: 'L', stock: 0 },
            ],
        })
        expect(manager.update).not.toHaveBeenCalled()
        expect(manager.upsert).not.toHaveBeenCalled()
        expect(manager.delete).not.toHaveBeenCalled()
    })

    it('requires the loaded count to change the stock of an existing variant', async () => {
        const { service, manager } = setup()
        const error = await service
            .update('p1', {
                variants: [{ ...VARIANT, id: 'v-s', label: 'S', stock: 10 }],
            })
            .catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(BadRequestException)
        expect((error as BadRequestException).getResponse()).toMatchObject({
            details: [{ field: 'variants.0.expectedStock' }],
        })
        expect(manager.upsert).not.toHaveBeenCalled()
    })

    describe('a product without variants', () => {
        const single = (): StoredStock => ({ product: { id: 'p1', stock: 8 }, variants: [] })
        const productWrite = (manager: ReturnType<typeof setup>['manager']) =>
            (manager.update.mock.calls[0] as [unknown, unknown, Record<string, unknown>])[2]

        it('keeps the current stock when it was not changed', async () => {
            const { service, manager } = setup(single())
            await service.update('p1', { name: 'Asad', stock: 10, expectedStock: 10, variants: [] })
            // Loaded at 10, orders left 8: the locked count is what stays.
            expect(productWrite(manager)).toMatchObject({ stock: 8 })
        })

        it('writes a changed stock when the loaded count matches', async () => {
            const { service, manager } = setup(single())
            await service.update('p1', { stock: 12, expectedStock: 8, variants: [] })
            expect(productWrite(manager)).toMatchObject({ stock: 12 })
        })

        it('rejects a stale loaded count with 409 STOCK_CHANGED', async () => {
            const { service, manager } = setup(single())
            const error = await service
                .update('p1', { stock: 12, expectedStock: 10 })
                .catch((caught: unknown) => caught)
            expect(error).toBeInstanceOf(ConflictException)
            expect((error as ConflictException).getResponse()).toMatchObject({
                code: STOCK_CHANGED,
                stock: 8,
                variants: [],
            })
            expect(manager.update).not.toHaveBeenCalled()
        })
    })
})
