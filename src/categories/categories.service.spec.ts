import { MemoryCache } from '../cache/memory-cache.js'
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { Repository } from 'typeorm'
import { QueryFailedError } from 'typeorm'
import type { Product } from '../products/entities/product.entity.js'
import type { StorageService } from '../storage/storage.service.js'
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

/** Uploads never reach the disk or Cloudinary. */
function storageMock() {
    return {
        uploadMedia: vi.fn((media: { type: string }) =>
            Promise.resolve({
                url: `http://localhost:3000/uploads/categories/new.${media.type}`,
                publicId: `categories/new.${media.type}`,
            }),
        ),
        deleteMedia: vi.fn().mockResolvedValue(undefined),
    }
}

function setup(options: {
    exists?: boolean
    productCount?: number
    maxSortOrder?: number | null
    /** The stored row `findOneBy` / `findOne` returns (update, remove). */
    current?: Partial<Category> | null
}) {
    const current =
        options.current === undefined
            ? options.exists
                ? { slug: 'arabes', imageUrl: null, imagePublicId: null }
                : null
            : options.current
    const categories = {
        existsBy: vi.fn().mockResolvedValue(options.exists ?? false),
        findOneBy: vi.fn().mockResolvedValue(current),
        findOne: vi.fn().mockResolvedValue(current),
        insert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue({ affected: 1 }),
        delete: vi.fn().mockResolvedValue({ affected: 1 }),
        createQueryBuilder: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            getRawOne: vi.fn().mockResolvedValue({ max: options.maxSortOrder ?? null }),
        })),
    }
    const products = {
        countBy: vi.fn().mockResolvedValue(options.productCount ?? 0),
        query: vi.fn().mockResolvedValue([]),
        createQueryBuilder: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            addSelect: vi.fn().mockReturnThis(),
            groupBy: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            getRawMany: vi.fn().mockResolvedValue([]),
        })),
    }
    const storage = storageMock()
    const service = new CategoriesService(
        categories as unknown as Repository<Category>,
        products as unknown as Repository<Product>,
        storage as unknown as StorageService,
        new MemoryCache(),
    )
    return { service, categories, products, storage }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const AVIF = Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]),
    Buffer.from('ftypavif\0\0\0\0avifmif1miaf', 'binary'),
    Buffer.alloc(32),
])

function file(buffer: Buffer, originalname = 'cover.png'): Express.Multer.File {
    return { buffer, originalname } as Express.Multer.File
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
        const { service, categories, storage } = setup({ exists: true, productCount: 0 })
        await service.remove('arabes')
        expect(categories.delete).toHaveBeenCalledWith({ slug: 'arabes' })
        expect(storage.deleteMedia).not.toHaveBeenCalled()
    })

    it('deletes the uploaded cover along with the category', async () => {
        const { service, storage } = setup({
            current: { slug: 'arabes', imagePublicId: 'categories/old.jpg' },
        })
        await service.remove('arabes')
        expect(storage.deleteMedia).toHaveBeenCalledWith({
            publicId: 'categories/old.jpg',
            kind: 'image',
        })
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
        query: vi.fn().mockResolvedValue([]),
    }
    const service = new CategoriesService(
        categories as unknown as Repository<Category>,
        products as unknown as Repository<Product>,
        storageMock() as unknown as StorageService,
        new MemoryCache(),
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

describe('CategoriesService cover image', () => {
    it('stores an uploaded cover under categories/ and exposes only its URL', async () => {
        const { service, categories, storage } = setup({})
        const created = await service.create({ ...INPUT, slug: 'arabes' }, file(PNG))

        expect(storage.uploadMedia).toHaveBeenCalledWith({ buffer: PNG, type: 'png' }, 'categories')
        expect(categories.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                imageUrl: 'http://localhost:3000/uploads/categories/new.png',
                imagePublicId: 'categories/new.png',
            }),
        )
        expect(created.imageUrl).toBe('http://localhost:3000/uploads/categories/new.png')
        expect(created).not.toHaveProperty('imagePublicId')
        expect(created.previewImageUrl).toBeNull()
    })

    it('accepts AVIF and an external URL', async () => {
        const avif = setup({})
        await avif.service.create({ ...INPUT, slug: 'arabes' }, file(AVIF, 'cover.avif'))
        expect(avif.storage.uploadMedia).toHaveBeenCalledWith(
            { buffer: AVIF, type: 'avif' },
            'categories',
        )

        const linked = setup({})
        await linked.service.create({ ...INPUT, imageUrl: 'https://cdn.example.com/a.jpg' })
        expect(linked.categories.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                imageUrl: 'https://cdn.example.com/a.jpg',
                imagePublicId: null,
            }),
        )
        expect(linked.storage.uploadMedia).not.toHaveBeenCalled()
    })

    it('rejects a file that is not really an image, before storing anything', async () => {
        const { service, categories, storage } = setup({})
        await expect(
            service.create({ ...INPUT, slug: 'arabes' }, file(Buffer.from('<svg/>'), 'x.png')),
        ).rejects.toThrow(
            new BadRequestException(
                'La imagen de portada debe ser un archivo JPG, PNG, WEBP o AVIF.',
            ),
        )
        expect(storage.uploadMedia).not.toHaveBeenCalled()
        expect(categories.insert).not.toHaveBeenCalled()
    })

    it('deletes the new file when the insert fails', async () => {
        const { service, categories, storage } = setup({})
        categories.insert.mockRejectedValueOnce(uniqueViolation())
        await expect(
            service.create({ ...INPUT, slug: 'arabes' }, file(PNG)),
        ).rejects.toBeInstanceOf(ConflictException)
        expect(storage.deleteMedia).toHaveBeenCalledWith({
            publicId: 'categories/new.png',
            kind: 'image',
        })
    })

    it('replaces an uploaded cover and deletes the old file', async () => {
        const { service, categories, storage } = setup({
            current: {
                slug: 'arabes',
                imageUrl: 'http://localhost:3000/uploads/categories/old.jpg',
                imagePublicId: 'categories/old.jpg',
            },
        })
        const updated = await service.update('arabes', {}, file(PNG))

        expect(categories.update).toHaveBeenCalledWith(
            { slug: 'arabes' },
            {
                imageUrl: 'http://localhost:3000/uploads/categories/new.png',
                imagePublicId: 'categories/new.png',
            },
        )
        expect(storage.deleteMedia).toHaveBeenCalledWith({
            publicId: 'categories/old.jpg',
            kind: 'image',
        })
        expect(updated.imageUrl).toBe('http://localhost:3000/uploads/categories/new.png')
    })

    it.each([
        ['removeImage: true', { removeImage: true }],
        ['imageUrl: null', { imageUrl: null }],
    ])('removes the cover with %s and deletes the stored file', async (_, dto) => {
        const { service, categories, storage } = setup({
            current: {
                slug: 'arabes',
                imageUrl: 'http://localhost:3000/uploads/categories/old.jpg',
                imagePublicId: 'categories/old.jpg',
            },
        })
        const updated = await service.update('arabes', dto)

        expect(categories.update).toHaveBeenCalledWith(
            { slug: 'arabes' },
            { imageUrl: null, imagePublicId: null },
        )
        expect(storage.deleteMedia).toHaveBeenCalledOnce()
        expect(updated.imageUrl).toBeNull()
    })

    it('keeps the stored file when other fields change or the same URL is sent back', async () => {
        const url = 'http://localhost:3000/uploads/categories/old.jpg'
        const { service, categories, storage } = setup({
            current: { slug: 'arabes', imageUrl: url, imagePublicId: 'categories/old.jpg' },
        })
        await service.update('arabes', { name: 'Árabes', imageUrl: url })

        expect(categories.update).toHaveBeenCalledWith({ slug: 'arabes' }, { name: 'Árabes' })
        expect(storage.deleteMedia).not.toHaveBeenCalled()
    })

    it('a failed update deletes the file it just stored and keeps the old one', async () => {
        const { service, categories, storage } = setup({
            current: { slug: 'arabes', imageUrl: 'x', imagePublicId: 'categories/old.jpg' },
        })
        categories.update.mockRejectedValueOnce(new Error('db down'))
        await expect(service.update('arabes', {}, file(PNG))).rejects.toThrow('db down')
        expect(storage.deleteMedia).toHaveBeenCalledTimes(1)
        expect(storage.deleteMedia).toHaveBeenCalledWith({
            publicId: 'categories/new.png',
            kind: 'image',
        })
    })
})

describe('CategoriesService preview images', () => {
    it('reads every preview in one query and maps it onto the public list', async () => {
        const { service, categories, products } = setup({})
        Object.assign(categories, {
            find: vi.fn().mockResolvedValue([
                { slug: 'arabes', name: 'Árabes', imageUrl: null },
                { slug: 'europeos', name: 'Europeos', imageUrl: 'https://cdn.example.com/e.jpg' },
                { slug: 'sets-regalo', name: 'Sets', imageUrl: null },
            ]),
        })
        products.query.mockResolvedValueOnce([
            { slug: 'arabes', url: 'https://cdn.example.com/khamrah.jpg' },
            { slug: 'europeos', url: 'https://cdn.example.com/sauvage.jpg' },
        ])

        const list = await service.list()

        expect(products.query).toHaveBeenCalledOnce()
        const [sql, params] = products.query.mock.calls[0] as [string, unknown[]]
        expect(sql).toContain('DISTINCT ON')
        expect(sql).toMatch(/is_featured" DESC, p\."relevance_score" DESC/)
        expect(params).toEqual([])
        expect(
            list.map(({ slug, imageUrl, previewImageUrl }) => ({
                slug,
                imageUrl,
                previewImageUrl,
            })),
        ).toEqual([
            {
                slug: 'arabes',
                imageUrl: null,
                previewImageUrl: 'https://cdn.example.com/khamrah.jpg',
            },
            {
                slug: 'europeos',
                imageUrl: 'https://cdn.example.com/e.jpg',
                previewImageUrl: 'https://cdn.example.com/sauvage.jpg',
            },
            { slug: 'sets-regalo', imageUrl: null, previewImageUrl: null },
        ])
        expect(list[0]).not.toHaveProperty('imagePublicId')
    })
})
