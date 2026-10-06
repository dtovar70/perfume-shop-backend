import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AdminCategoriesController } from '../src/categories/categories.controller.js'
import { CategoriesService } from '../src/categories/categories.service.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'

/**
 * Mounts only the admin categories controller (no auth guards, service mocked) to check routing
 * and validation: `PATCH /admin/categories/order` must never be captured by `PATCH :slug`.
 */
describe('Admin categories routes (e2e)', () => {
    let app: INestApplication
    const service = {
        reorder: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ slug: 'mugs' }),
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
            .send({ slugs: ['tees', 'mugs', 'keychains'] })
            .expect(200)
        expect(service.reorder).toHaveBeenCalledWith(['tees', 'mugs', 'keychains'])
        expect(service.update).not.toHaveBeenCalled()
    })

    it('PATCH /api/admin/categories/:slug still updates a category', async () => {
        await request(app.getHttpServer())
            .patch('/api/admin/categories/mugs')
            .send({ name: 'Perfumes' })
            .expect(200)
        expect(service.update).toHaveBeenCalledWith('mugs', { name: 'Perfumes' })
        expect(service.reorder).not.toHaveBeenCalled()
    })

    it('rejects repeated slugs in Spanish before reaching the service', async () => {
        const response = await request(app.getHttpServer())
            .patch('/api/admin/categories/order')
            .send({ slugs: ['mugs', 'mugs'] })
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
