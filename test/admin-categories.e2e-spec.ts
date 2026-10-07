import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { getRepositoryToken } from '@nestjs/typeorm'
import {
    AdminCategoriesController,
    CategoriesController,
} from '../src/categories/categories.controller.js'
import { CategoriesService } from '../src/categories/categories.service.js'
import { Category } from '../src/categories/entities/category.entity.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { Product } from '../src/products/entities/product.entity.js'
import { STORAGE_SERVICE } from '../src/storage/storage.service.js'

/**
 * Mounts only the admin categories controller (no auth guards, service mocked) to check routing
 * and validation: `PATCH /admin/categories/order` must never be captured by `PATCH :slug`.
 */
describe('Admin categories routes (e2e)', () => {
    let app: INestApplication
    const service = {
        reorder: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ slug: 'arabes' }),
    }

    beforeEach(async () => {
        vi.clearAllMocks()
        const moduleFixture = await Test.createTestingModule({
            controllers: [AdminCategoriesController],
            providers: [{ provide: CategoriesService, useValue: service }],
        }).compile()

        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.useGlobalPipes(createValidationPipe())
        await app.init()
    })

    afterEach(async () => {
        await app.close()
    })

    it('PATCH /api/admin/categories/order reorders instead of updating a category', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/categories/order')
            .send({ slugs: ['sets-regalo', 'arabes', 'europeos'] })
            .expect(200)
        expect(service.reorder).toHaveBeenCalledWith(['sets-regalo', 'arabes', 'europeos'])
        expect(service.update).not.toHaveBeenCalled()
    })

    it('PATCH /api/admin/categories/:slug still updates a category', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .send({ name: 'Perfumes' })
            .expect(200)
        expect(service.update).toHaveBeenCalledWith('arabes', { name: 'Perfumes' }, undefined)
        expect(service.reorder).not.toHaveBeenCalled()
    })

    it('rejects repeated slugs in Spanish before reaching the service', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/categories/order')
            .send({ slugs: ['arabes', 'arabes'] })
            .expect(400)
        expect(response.body.details).toEqual([
            {
                field: 'slugs',
                errors: ['La lista de categorías no puede tener elementos repetidos.'],
            },
        ])
        expect(service.reorder).not.toHaveBeenCalled()
    })

    it('rejects a missing list in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/categories/order')
            .send({})
            .expect(400)
        expect(response.body.details[0].field).toBe('slugs')
        expect(response.body.details[0].errors).toContain(
            'La lista de categorías debe ser una lista.',
        )
    })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const AVIF = Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]),
    Buffer.from('ftypavif\0\0\0\0avifmif1miaf', 'binary'),
    Buffer.alloc(32),
])
const MB = 1024 * 1024
const UPLOADED = 'http://localhost:3000/uploads/categories/old.jpg'

/** `size` bytes that start with `head`. */
function padded(head: Buffer, size: number): Buffer {
    return Buffer.concat([head, Buffer.alloc(size - head.length)])
}

/**
 * The cover image through the real controllers, upload interceptor and service, with the
 * database and the storage stubbed: nothing reaches the disk or Cloudinary.
 */
describe('Category cover image (e2e)', () => {
    let app: INestApplication
    const row = () => ({
        slug: 'arabes',
        name: 'Árabes',
        tagline: 'La opulencia de Oriente',
        description: '',
        colorHex: '#C9A227',
        sortOrder: 0,
        imageUrl: UPLOADED,
        imagePublicId: 'categories/old.jpg',
    })
    const categories = {
        existsBy: vi.fn(),
        findOneBy: vi.fn(),
        findOne: vi.fn(),
        find: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        createQueryBuilder: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            getRawOne: vi.fn().mockResolvedValue({ max: 2 }),
        })),
    }
    const products = {
        countBy: vi.fn(),
        query: vi.fn(),
        createQueryBuilder: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            addSelect: vi.fn().mockReturnThis(),
            groupBy: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            getRawMany: vi.fn().mockResolvedValue([{ slug: 'arabes', active: '4', total: '5' }]),
        })),
    }
    const storage = {
        driver: 'local' as const,
        uploadMedia: vi.fn((media: { type: string }) =>
            Promise.resolve({
                url: `http://localhost:3000/uploads/categories/new.${media.type}`,
                publicId: `categories/new.${media.type}`,
            }),
        ),
        deleteMedia: vi.fn().mockResolvedValue(undefined),
    }

    beforeEach(async () => {
        vi.clearAllMocks()
        categories.existsBy.mockResolvedValue(false)
        categories.findOneBy.mockResolvedValue(row())
        categories.findOne.mockResolvedValue(row())
        categories.find.mockResolvedValue([row()])
        categories.insert.mockResolvedValue(undefined)
        categories.update.mockResolvedValue({ affected: 1 })
        categories.delete.mockResolvedValue({ affected: 1 })
        products.countBy.mockResolvedValue(0)
        products.query.mockResolvedValue([
            { slug: 'arabes', url: 'https://res.cloudinary.com/x/image/upload/v1/p.jpg' },
        ])

        const moduleFixture = await Test.createTestingModule({
            controllers: [CategoriesController, AdminCategoriesController],
            providers: [
                CategoriesService,
                { provide: getRepositoryToken(Category), useValue: categories },
                { provide: getRepositoryToken(Product), useValue: products },
                { provide: STORAGE_SERVICE, useValue: storage },
            ],
        }).compile()

        app = moduleFixture.createNestApplication()
        app.setGlobalPrefix('api')
        app.useGlobalPipes(createValidationPipe())
        await app.init()
    })

    afterEach(async () => {
        await app.close()
    })

    it('GET /api/categories exposes the cover and the preview, never the storage key', async () => {
        const response = await request(app.getHttpServer()).get('/api/categories').expect(200)
        expect(response.body).toEqual([
            {
                slug: 'arabes',
                name: 'Árabes',
                tagline: 'La opulencia de Oriente',
                description: '',
                colorHex: '#C9A227',
                imageUrl: UPLOADED,
                previewImageUrl: 'https://res.cloudinary.com/x/image/upload/v1/p.jpg',
                productCount: 4,
            },
        ])
        expect(products.query).toHaveBeenCalledOnce()
    })

    it('POST multipart stores the cover and converts the text fields', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/admin/categories')
            .field('name', 'Nicho')
            .field('colorHex', '#112233')
            .field('sortOrder', '4')
            .attach('image', AVIF, { filename: 'cover.avif', contentType: 'image/avif' })
            .expect(201)

        expect(storage.uploadMedia).toHaveBeenCalledWith(
            { buffer: expect.any(Buffer), type: 'avif' },
            'categories',
        )
        expect(categories.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                slug: 'nicho',
                sortOrder: 4,
                imageUrl: 'http://localhost:3000/uploads/categories/new.avif',
                imagePublicId: 'categories/new.avif',
            }),
        )
        expect(response.body.imageUrl).toBe('http://localhost:3000/uploads/categories/new.avif')
        expect(response.body).not.toHaveProperty('imagePublicId')
    })

    it('PATCH multipart replaces the cover and deletes the old file', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .attach('image', PNG, { filename: 'cover.png', contentType: 'image/png' })
            .expect(200)
        expect(response.body.imageUrl).toBe('http://localhost:3000/uploads/categories/new.png')
        expect(storage.deleteMedia).toHaveBeenCalledWith({
            publicId: 'categories/old.jpg',
            kind: 'image',
        })
    })

    it('PATCH removes the cover with removeImage (multipart text) or imageUrl: null (JSON)', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .field('removeImage', 'true')
            .expect(200)
        await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .send({ imageUrl: null })
            .expect(200)

        expect(categories.update).toHaveBeenNthCalledWith(
            1,
            { slug: 'arabes' },
            { imageUrl: null, imagePublicId: null },
        )
        expect(categories.update).toHaveBeenNthCalledWith(
            2,
            { slug: 'arabes' },
            { imageUrl: null, imagePublicId: null },
        )
        expect(storage.deleteMedia).toHaveBeenCalledTimes(2)
    })

    it('rejects other file types, by mimetype and by real content', async () => {
        const svg = await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .attach('image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
                filename: 'cover.svg',
                contentType: 'image/svg+xml',
            })
            .expect(400)
        expect(svg.body.message).toBe(
            'La imagen de portada debe ser un archivo JPG, PNG, WEBP o AVIF.',
        )

        const disguised = await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .attach('image', Buffer.from('GIF89a-not-a-png'), {
                filename: 'cover.png',
                contentType: 'image/png',
            })
            .expect(400)
        expect(disguised.body.message).toBe(svg.body.message)
        expect(storage.uploadMedia).not.toHaveBeenCalled()
        expect(categories.update).not.toHaveBeenCalled()
    })

    it('rejects a cover over 5 MB in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .attach('image', padded(PNG, 5 * MB + 1), {
                filename: 'big.png',
                contentType: 'image/png',
            })
            .expect(413)
        expect(response.body.message).toBe('La imagen de portada puede pesar como máximo 5 MB.')
        expect(storage.uploadMedia).not.toHaveBeenCalled()
    })

    it('validates the cover URL in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/categories/arabes')
            .send({ imageUrl: 'javascript:alert(1)' })
            .expect(400)
        expect(response.body.details).toEqual([
            {
                field: 'imageUrl',
                errors: ['La imagen de portada debe ser una dirección web válida (https://…).'],
            },
        ])
        expect(categories.update).not.toHaveBeenCalled()
    })

    it('DELETE removes the uploaded cover too', async () => {
        await request(app.getHttpServer()).delete('/api/admin/categories/arabes').expect(204)
        expect(storage.deleteMedia).toHaveBeenCalledWith({
            publicId: 'categories/old.jpg',
            kind: 'image',
        })
    })
})
