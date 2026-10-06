import { plainToInstance, type ClassConstructor } from 'class-transformer'
import { validate } from 'class-validator'
import { LoginDto } from '../../auth/dto/login.dto.js'
import { CreateCategoryDto } from '../../categories/dto/create-category.dto.js'
import { ContactContentDto } from '../../content/dto/contact.dto.js'
import { CreateOrderDto } from '../../orders/dto/create-order.dto.js'
import { SubmitPaymentDto } from '../../orders/dto/submit-payment.dto.js'
import { TEXT_INPUT_MAX_LENGTH } from './text-limits.js'

/** Messages of the constraints that failed on `field`. */
async function errorsOn<T extends object>(
    dto: ClassConstructor<T>,
    body: object,
    field: string,
): Promise<string[]> {
    const errors = await validate(plainToInstance(dto, body))
    return Object.values(errors.find((error) => error.property === field)?.constraints ?? {})
}

const tooLong = 'x'.repeat(TEXT_INPUT_MAX_LENGTH + 1)

describe('single-line text limit (100 characters)', () => {
    const order = {
        fullName: 'Ana Pérez',
        email: 'ana@correo.com',
        phone: '0412-5550134',
        city: 'Valencia',
        address: 'Av. Bolívar 123',
        deliveryMethod: 'delivery',
        items: [{ productId: 'p1', quantity: 1 }],
    }

    it('applies to the checkout name and address', async () => {
        expect(await errorsOn(CreateOrderDto, order, 'fullName')).toEqual([])
        expect(
            await errorsOn(CreateOrderDto, { ...order, fullName: tooLong }, 'fullName'),
        ).toContain('El nombre y apellido no puede superar los 100 caracteres.')
        expect(await errorsOn(CreateOrderDto, { ...order, address: tooLong }, 'address')).toContain(
            'La dirección no puede superar los 100 caracteres.',
        )
        expect(
            await errorsOn(CreateOrderDto, { ...order, address: 'x'.repeat(100) }, 'address'),
        ).toEqual([])
    })

    it('applies to the checkout email', async () => {
        const email = `${'a'.repeat(90)}@correo.com`
        expect(await errorsOn(CreateOrderDto, { ...order, email }, 'email')).toContain(
            'El correo no puede superar los 100 caracteres.',
        )
    })

    it('keeps the 300-character notes (a textarea)', async () => {
        expect(
            await errorsOn(CreateOrderDto, { ...order, notes: 'x'.repeat(300) }, 'notes'),
        ).toEqual([])
        expect(
            await errorsOn(CreateOrderDto, { ...order, notes: 'x'.repeat(301) }, 'notes'),
        ).toContain('Las notas no puede superar los 300 caracteres.')
    })

    it('applies to the payment form fields', async () => {
        const reference = '1'.repeat(TEXT_INPUT_MAX_LENGTH + 1)
        expect(await errorsOn(SubmitPaymentDto, { reference }, 'reference')).toContain(
            'La referencia no puede superar los 100 caracteres.',
        )
    })

    it('applies to the category tagline and the login email', async () => {
        const category = { name: 'Perfumes', colorHex: '#FFD979' }
        expect(
            await errorsOn(CreateCategoryDto, { ...category, tagline: tooLong }, 'tagline'),
        ).toContain('El eslogan de la categoría no puede superar los 100 caracteres.')
        expect(
            await errorsOn(LoginDto, { email: `${'a'.repeat(95)}@x.com`, password: 'x' }, 'email'),
        ).toContain('El correo electrónico no puede superar los 100 caracteres.')
    })

    it('applies to single-line content fields', async () => {
        expect(await errorsOn(ContactContentDto, { schedule: tooLong }, 'schedule')).toContain(
            'El horario no puede superar los 100 caracteres.',
        )
    })
})
