import { BadRequestException, type ArgumentMetadata } from '@nestjs/common'
import { LoginDto } from '../../auth/dto/login.dto.js'
import { CreateCategoryDto } from '../../categories/dto/create-category.dto.js'
import { UpdateCategoryDto } from '../../categories/dto/update-category.dto.js'
import { CreateProductDto } from '../../products/dto/create-product.dto.js'
import { FeaturedQueryDto, RelatedQueryDto } from '../../products/dto/limit-query.dto.js'
import { UpdateProductDto } from '../../products/dto/update-product.dto.js'
import { createValidationPipe } from './validation.pipe.js'

interface FieldError {
    field: string
    errors: string[]
}

const VALID_PRODUCT = {
    name: 'Perfume de prueba',
    categorySlug: 'arabes',
    price: 10,
    description: 'Descripción',
    stock: 3,
}

async function detailsFor(
    value: unknown,
    metatype: ArgumentMetadata['metatype'],
    type: ArgumentMetadata['type'] = 'body',
): Promise<FieldError[]> {
    try {
        await createValidationPipe().transform(value, { type, metatype })
    } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException)
        return ((error as BadRequestException).getResponse() as { details: FieldError[] }).details
    }
    throw new Error('Expected the payload to be rejected')
}

function errorsOf(details: FieldError[], field: string): string[] {
    return details.find((detail) => detail.field === field)?.errors ?? []
}

describe('createValidationPipe', () => {
    it('returns Spanish per-field messages that name the field', async () => {
        const details = await detailsFor(
            { ...VALID_PRODUCT, price: -1, variants: [{ label: '', priceDelta: 0, stock: 1 }] },
            CreateProductDto,
        )
        expect(errorsOf(details, 'price')).toEqual(['El precio no puede ser negativo.'])
        expect(errorsOf(details, 'variants.0.label')).toEqual([
            'La etiqueta de la variante es obligatoria.',
        ])
        expect(errorsOf(details, 'variants.0.stock')).toEqual([])
    })

    it('reports missing required fields in Spanish', async () => {
        const details = await detailsFor({ variants: [{ label: 'M' }] }, CreateProductDto)
        const messages = details.flatMap((detail) => detail.errors)
        expect(messages).toContain('El nombre es obligatorio.')
        // The product's own stock is optional (with variants it is their sum).
        expect(errorsOf(details, 'stock')).toEqual([])
        expect(errorsOf(details, 'variants.0.stock')).toContain(
            'El stock de la variante debe ser un número entero.',
        )
        for (const message of messages) {
            expect(message).not.toMatch(/must|should|each value/)
        }
    })

    it('translates unknown properties, also inside nested variants', async () => {
        const details = await detailsFor(
            {
                ...VALID_PRODUCT,
                barcode: 'X',
                variants: [{ label: 'A', priceDelta: 0, stock: 1, foo: 1 }],
            },
            CreateProductDto,
        )
        expect(errorsOf(details, 'barcode')).toEqual(['El campo "barcode" no está permitido.'])
        expect(errorsOf(details, 'variants.0.foo')).toEqual(['El campo "foo" no está permitido.'])
    })

    it('rejects variants that are not objects with a Spanish message', async () => {
        const details = await detailsFor({ variants: ['nope'] }, UpdateProductDto)
        expect(errorsOf(details, 'variants.0')).toEqual(['Cada variante debe ser un objeto.'])
    })

    it('keeps the login messages in Spanish', async () => {
        const details = await detailsFor({ email: 'x', password: '' }, LoginDto)
        expect(errorsOf(details, 'email')).toEqual(['Ingresa un correo electrónico válido.'])
        expect(errorsOf(details, 'password')).toEqual(['Ingresa tu contraseña.'])
    })

    it('validates new categories in Spanish', async () => {
        const details = await detailsFor(
            { name: '', slug: 'Perfumes Grandes', colorHex: 'rosa', sortOrder: -1 },
            CreateCategoryDto,
        )
        expect(errorsOf(details, 'name')).toEqual(['El nombre de la categoría es obligatorio.'])
        expect(errorsOf(details, 'slug')).toEqual([
            'El slug solo admite minúsculas, números y guiones.',
        ])
        expect(errorsOf(details, 'colorHex')).toEqual([
            'El color de la categoría debe tener formato hexadecimal, por ejemplo #FFB3D1.',
        ])
        expect(errorsOf(details, 'sortOrder')).toEqual([
            'La posición de la categoría no puede ser negativa.',
        ])
    })

    it('accepts a partial category update but never a new slug', async () => {
        await expect(
            createValidationPipe().transform(
                { sortOrder: 2 },
                { type: 'body', metatype: UpdateCategoryDto },
            ),
        ).resolves.toEqual(expect.objectContaining({ sortOrder: 2 }))

        const details = await detailsFor({ slug: 'otra' }, UpdateCategoryDto)
        expect(errorsOf(details, 'slug')).toEqual(['El campo "slug" no está permitido.'])
    })

    it('bounds the featured and related limits', async () => {
        expect(
            errorsOf(await detailsFor({ limit: '999' }, FeaturedQueryDto, 'query'), 'limit'),
        ).toEqual(['El límite no puede ser mayor que 24.'])
        expect(
            errorsOf(await detailsFor({ limit: '0' }, RelatedQueryDto, 'query'), 'limit'),
        ).toEqual(['El límite debe ser como mínimo 1.'])
        expect(
            errorsOf(await detailsFor({ limit: 'abc' }, RelatedQueryDto, 'query'), 'limit'),
        ).toContain('El límite debe ser un número entero.')
    })

    it('applies the default limits when absent', async () => {
        const pipe = createValidationPipe()
        await expect(
            pipe.transform({}, { type: 'query', metatype: FeaturedQueryDto }),
        ).resolves.toEqual(expect.objectContaining({ limit: 8 }))
        await expect(
            pipe.transform({ limit: '2' }, { type: 'query', metatype: RelatedQueryDto }),
        ).resolves.toEqual(expect.objectContaining({ limit: 2 }))
    })
})
