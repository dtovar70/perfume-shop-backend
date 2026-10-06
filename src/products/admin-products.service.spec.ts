import type { DataSource, Repository } from 'typeorm'
import type { Brand } from '../brands/entities/brand.entity.js'
import type { Category } from '../categories/entities/category.entity.js'
import type { StorageService } from '../storage/storage.service.js'
import { AdminProductsService } from './admin-products.service.js'
import type { CreateProductDto } from './dto/create-product.dto.js'
import type { ProductImage } from './entities/product-image.entity.js'
import { ProductVariant } from './entities/product-variant.entity.js'
import { Product } from './entities/product.entity.js'
import type { ProductRepository } from './product.repository.js'

function setup() {
    const manager = {
        insert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        upsert: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
        find: vi.fn().mockResolvedValue([{ id: 'v-s' }, { id: 'v-m' }, { id: 'v-l' }]),
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
})
