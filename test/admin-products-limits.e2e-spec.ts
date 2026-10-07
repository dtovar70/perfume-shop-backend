import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { CacheModule } from '../src/cache/cache.module.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { AdminProductsController } from '../src/products/admin-products.controller.js'
import { AdminProductsService } from '../src/products/admin-products.service.js'
import { ProductImagesService } from '../src/products/product-images.service.js'

/**
 * Mounts only the admin products controller (no auth guards, services mocked) to check the
 * length and list limits of the product form: single-line texts stop at 100 characters and a
 * product has at most 6 highlights.
 */
describe('Admin products limits (e2e)', () => {
    let app: INestApplication
    const products = {
        create: vi.fn().mockResolvedValue({ id: 'p1' }),
        update: vi.fn().mockResolvedValue({ id: 'p1' }),
    }

    const validProduct = {
        name: 'Lattafa Khamrah',
        categorySlug: 'arabes',
        price: 45,
        brandSlug: 'lattafa',
        gender: 'unisex',
        concentration: 'EDP',
        volumeMl: 100,
        notesTop: ['Canela'],
        description: '',
        stock: 3,
    }

    beforeEach(async () => {
        vi.clearAllMocks()
        const moduleFixture = await Test.createTestingModule({
            imports: [CacheModule],
            controllers: [AdminProductsController],
            providers: [
                { provide: AdminProductsService, useValue: products },
                { provide: ProductImagesService, useValue: {} },
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

    const errorsOf = (body: { details: { field: string; errors: string[] }[] }, field: string) =>
        body.details.find((detail) => detail.field === field)?.errors ?? []

    it('accepts a 100-character name', async () => {
        await request(app.getHttpServer())
            .post('/api/admin/products')
            .send({ ...validProduct, name: 'x'.repeat(100) })
            .expect(201)
        expect(products.create).toHaveBeenCalledOnce()
    })

    it('rejects a 101-character name in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/admin/products')
            .send({ ...validProduct, name: 'x'.repeat(101) })
            .expect(400)
        expect(errorsOf(response.body, 'name')).toContain(
            'El nombre no puede superar los 100 caracteres.',
        )
        expect(products.create).not.toHaveBeenCalled()
    })

    it('requires a whole, non-negative stock per variant', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({
                variants: [
                    { label: 'S', priceDelta: 0 },
                    { label: 'M', priceDelta: 0, stock: -1 },
                    { label: 'L', priceDelta: 0, stock: 1.5 },
                ],
            })
            .expect(400)
        expect(errorsOf(response.body, 'variants.0.stock')).toContain(
            'El stock de la variante debe ser un número entero.',
        )
        expect(errorsOf(response.body, 'variants.1.stock')).toEqual([
            'El stock de la variante no puede ser negativo.',
        ])
        expect(errorsOf(response.body, 'variants.2.stock')).toEqual([
            'El stock de la variante debe ser un número entero.',
        ])
        expect(products.update).not.toHaveBeenCalled()

        await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ variants: [{ id: 'v-s', label: 'S', priceDelta: 0, stock: 0 }] })
            .expect(200)
        expect(products.update).toHaveBeenCalledOnce()
    })

    it('rejects a 101-character variant label on update', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ variants: [{ label: 'x'.repeat(101), priceDelta: 0 }] })
            .expect(400)
        expect(JSON.stringify(response.body.details)).toContain('no puede superar los')
        expect(products.update).not.toHaveBeenCalled()
    })

    it('accepts 6 highlights and rejects 7', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ highlights: ['a', 'b', 'c', 'd', 'e', 'f'] })
            .expect(200)

        const response = await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ highlights: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
            .expect(400)
        expect(errorsOf(response.body, 'highlights')).toContain(
            'La lista de destacados admite como máximo 6 elementos.',
        )
        expect(products.update).toHaveBeenCalledOnce()
    })

    it('rejects a highlight longer than 100 characters', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ highlights: ['x'.repeat(101)] })
            .expect(400)
        expect(errorsOf(response.body, 'highlights')).toContain(
            'Cada destacado no puede superar los 100 caracteres.',
        )
    })

    it('keeps the larger limit of the description (a textarea)', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ description: 'x'.repeat(4000) })
            .expect(200)
        const response = await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ description: 'x'.repeat(4001) })
            .expect(400)
        expect(errorsOf(response.body, 'description')).toContain(
            'La descripción no puede superar los 4000 caracteres.',
        )
    })

    it('validates the perfume fields in Spanish', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/admin/products')
            .send({
                ...validProduct,
                gender: 'otro',
                concentration: 'XYZ',
                volumeMl: 0,
                notesTop: Array.from({ length: 13 }, (_, index) => `Nota ${index}`),
                sku: 'KZ 0001',
                variants: [{ label: '50 ml', priceDelta: 0, stock: 1, volumeMl: 1.5 }],
            })
            .expect(400)
        expect(errorsOf(response.body, 'gender')).toEqual(['El género no es válido.'])
        expect(errorsOf(response.body, 'concentration')).toEqual(['La concentración no es válida.'])
        expect(errorsOf(response.body, 'volumeMl')).toHaveLength(1)
        expect(errorsOf(response.body, 'notesTop')).toHaveLength(1)
        expect(errorsOf(response.body, 'sku')).toEqual([
            'El SKU solo admite letras, números, puntos, guiones y guiones bajos.',
        ])
        expect(errorsOf(response.body, 'variants.0.volumeMl')).toHaveLength(1)
        expect(products.create).not.toHaveBeenCalled()
    })

    it('accepts null to clear the brand, concentration, family and SKU on update', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/products/p1')
            .send({ brandSlug: null, concentration: null, olfactoryFamily: null, sku: null })
            .expect(200)
        expect(products.update).toHaveBeenCalledOnce()
    })
})
