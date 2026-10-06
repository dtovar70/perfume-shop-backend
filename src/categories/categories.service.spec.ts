import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { Repository } from 'typeorm'
import { QueryFailedError } from 'typeorm'
import type { Product } from '../products/entities/product.entity.js'
import {
    CATEGORY_ORDER_MISMATCH,
    CategoriesService,
    categoryInUseMessage,
} from './categories.service.js'
import type { Category } from './entities/category.entity.js'

function uniqueViolation(): QueryFailedError {
    return new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('duplicate'), { code: '23505' }),
    )
}

function setup(options: { exists?: boolean; productCount?: number; maxSortOrder?: number | null }) {
    const categories = {
        existsBy: vi.fn().mockResolvedValue(options.exists ?? false),
        insert: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue({ affected: 1 }),
        createQueryBuilder: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            getRawOne: vi.fn().mockResolvedValue({ max: options.maxSortOrder ?? null }),
        })),
    }
    const products = {
        countBy: vi.fn().mockResolvedValue(options.productCount ?? 0),
    }
    const service = new CategoriesService(
        categories as unknown as Repository<Category>,
        products as unknown as Repository<Product>,
    )
    return { service, categories, products }
}

const INPUT = { name: 'Perfumes Árabes', colorHex: '#FFD979' }

describe('CategoriesService.create', () => {
    it('derives the slug from the name and appends the category at the end', async () => {
        const { service, categories } = setup({ maxSortOrder: 2 })
        const created = await service.create({ ...INPUT, name: 'Perfumes Árabes Ñandú' })

        expect(categories.insert).toHaveBeenCalledWith(
            expect.objectContaining({ slug: 'perfumes-arabes-nandu', sortOrder: 3, tagline: '' }),
        )
        expect(created).toMatchObject({
            slug: 'perfumes-arabes-nandu',
            productCount: 0,
            totalProductCount: 0,
            sortOrder: 3,
        })
    })

    it('starts at position 0 when there are no categories and keeps an explicit position', async () => {
        const empty = setup({ maxSortOrder: null })
        await empty.service.create(INPUT)
        expect(empty.categories.insert).toHaveBeenCalledWith(
            expect.objectContaining({ sortOrder: 0 }),
        )

        const explicit = setup({ maxSortOrder: 5 })
        await explicit.service.create({ ...INPUT, slug: 'arabes', sortOrder: 1 })
        expect(explicit.categories.insert).toHaveBeenCalledWith(
            expect.objectContaining({ slug: 'arabes', sortOrder: 1 }),
        )
    })

    it('rejects a slug that is already taken with a Spanish 409', async () => {
        const { service, categories } = setup({ exists: true })
        await expect(service.create({ ...INPUT, slug: 'europeos' })).rejects.toThrow(
            new ConflictException('Ya existe una categoría con el slug "europeos".'),
        )
        expect(categories.insert).not.toHaveBeenCalled()
    })

    it('maps a concurrent unique violation to the same 409', async () => {
        const { service, categories } = setup({})
        categories.insert.mockRejectedValueOnce(uniqueViolation())
        await expect(service.create({ ...INPUT, slug: 'arabes' })).rejects.toBeInstanceOf(
            ConflictException,
        )
    })

    it('refuses a name that yields an empty slug', async () => {
        const { service } = setup({})
        await expect(service.create({ ...INPUT, name: '¡¡!!' })).rejects.toThrow(
            'No pudimos generar un slug a partir del nombre. Escribe uno a mano.',
        )
    })
})

describe('CategoriesService.remove', () => {
    it('deletes an empty category', async () => {
        const { service, categories } = setup({ exists: true, productCount: 0 })
        await service.remove('arabes')
        expect(categories.delete).toHaveBeenCalledWith({ slug: 'arabes' })
    })

    it('refuses while the category has products, active or hidden, and says how many', async () => {
        const { service, categories, products } = setup({ exists: true, productCount: 6 })
        await expect(service.remove('europeos')).rejects.toThrow(
            new ConflictException(
                'No puedes eliminar esta categoría porque tiene 6 productos. Muévelos a otra categoría o elimínalos primero.',
            ),
        )
        // No `isActive` filter: hidden products also block the delete.
        expect(products.countBy).toHaveBeenCalledWith({ categorySlug: 'europeos' })
        expect(categories.delete).not.toHaveBeenCalled()
    })

    it('returns 404 for an unknown category', async () => {
        const { service } = setup({ exists: false })
        await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException)
    })
})

describe('categoryInUseMessage', () => {
    it('agrees in number', () => {
        expect(categoryInUseMessage(1)).toBe(
            'No puedes eliminar esta categoría porque tiene 1 producto. Muévelo a otra categoría o elimínalo primero.',
        )
    })
})

function setupReorder(existing: string[]) {
    const manager = {
        find: vi.fn().mockResolvedValue(existing.map((slug) => ({ slug }))),
        update: vi.fn().mockResolvedValue({ affected: 1 }),
    }
    const categories = {
        manager: {
            transaction: vi.fn((work: (m: typeof manager) => Promise<void>) => work(manager)),
        },
        find: vi.fn().mockResolvedValue([]),
    }
    const products = {
        createQueryBuilder: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            addSelect: vi.fn().mockReturnThis(),
            groupBy: vi.fn().mockReturnThis(),
            getRawMany: vi.fn().mockResolvedValue([]),
        })),
    }
    const service = new CategoriesService(
        categories as unknown as Repository<Category>,
        products as unknown as Repository<Product>,
    )
    return { service, categories, manager }
}

describe('CategoriesService.reorder', () => {
    it('writes positions 0..n-1 in the given order inside one transaction', async () => {
        const { service, categories, manager } = setupReorder(['arabes', 'europeos', 'sets-regalo'])
        await service.reorder(['sets-regalo', 'arabes', 'europeos'])

        expect(categories.manager.transaction).toHaveBeenCalledTimes(1)
        expect(manager.update.mock.calls.map((call) => [call[1], call[2]])).toEqual([
            [{ slug: 'sets-regalo' }, { sortOrder: 0 }],
            [{ slug: 'arabes' }, { sortOrder: 1 }],
            [{ slug: 'europeos' }, { sortOrder: 2 }],
        ])
        // Returns the refreshed admin list.
        expect(categories.find).toHaveBeenCalled()
    })

    it.each([
        ['a missing category', ['arabes', 'europeos']],
        ['an unknown slug', ['arabes', 'europeos', 'nicho']],
        ['a repeated slug', ['arabes', 'europeos', 'europeos']],
        ['an extra slug', ['arabes', 'europeos', 'sets-regalo', 'nicho']],
    ])('refuses a list with %s with a Spanish 400 and writes nothing', async (_, slugs) => {
        const { service, manager } = setupReorder(['arabes', 'europeos', 'sets-regalo'])
        await expect(service.reorder(slugs)).rejects.toThrow(
            new BadRequestException(CATEGORY_ORDER_MISMATCH),
        )
        expect(manager.update).not.toHaveBeenCalled()
    })
})

describe('CategoriesService.create reserved slugs', () => {
    it('refuses the slug used by the reorder route', async () => {
        const { service, categories } = setup({})
        await expect(service.create({ ...INPUT, slug: 'order' })).rejects.toBeInstanceOf(
            BadRequestException,
        )
        await expect(service.create({ ...INPUT, name: 'Order' })).rejects.toBeInstanceOf(
            BadRequestException,
        )
        expect(categories.insert).not.toHaveBeenCalled()
    })
})
