import { ORDER_STATUSES } from '../order-status.js'
import {
    DEFAULT_WHATSAPP_TEMPLATES,
    firstName,
    renderWhatsAppTemplate,
    toWhatsAppPhone,
    usedPlaceholders,
    whatsAppTemplateError,
    whatsAppUrl,
    withoutFinalPunctuation,
    type WhatsAppValues,
} from './whatsapp-template.js'

const VALUES: WhatsAppValues = {
    nombre: 'Ana',
    pedido: 'KZ-000123',
    enlace: 'https://kaizen.com/pedido/KZ-000123?t=abc',
    total: '$36,00 (Bs. 30.760,69)',
    motivo: 'La referencia no coincide',
    marca: 'KaiZen Perfumería',
    envio: 'MRW, guía 123456',
    comprobante: 'https://api.kaizen.com/api/orders/KZ-000123/receipt.pdf?t=abc',
}

describe('WhatsApp templates', () => {
    it('renders every placeholder', () => {
        expect(renderWhatsAppTemplate(DEFAULT_WHATSAPP_TEMPLATES.PAGO_RECHAZADO, VALUES)).toBe(
            'Hola Ana 👋 Revisamos el pago de tu pedido KZ-000123 y no pudimos aprobarlo: La referencia no coincide. Puedes subir un nuevo comprobante aquí: https://kaizen.com/pedido/KZ-000123?t=abc',
        )
        expect(
            renderWhatsAppTemplate(
                '{nombre}|{pedido}|{enlace}|{total}|{motivo}|{marca}|{envio}|{comprobante}',
                VALUES,
            ),
        ).toBe(Object.values(VALUES).join('|'))
    })

    it('tidies what an empty value leaves behind', () => {
        const values = { ...VALUES, motivo: '' }
        expect(renderWhatsAppTemplate(DEFAULT_WHATSAPP_TEMPLATES.CANCELADO, values)).toBe(
            'Hola Ana. Te escribimos por tu pedido KZ-000123: lo cancelamos. Si hiciste un pago o tienes alguna duda, respóndenos por aquí y lo resolvemos juntos.',
        )
        expect(renderWhatsAppTemplate('Motivo: {motivo}.\n  Fin  ', values)).toBe('Motivo.\nFin')
    })

    it('ships a valid template for every status', () => {
        for (const status of ORDER_STATUSES) {
            const template = DEFAULT_WHATSAPP_TEMPLATES[status]
            expect(whatsAppTemplateError(template, status)).toBeNull()
            expect(template.length).toBeLessThanOrEqual(1000)
        }
        expect([...usedPlaceholders(DEFAULT_WHATSAPP_TEMPLATES.PAGO_VERIFICADO)]).toEqual([
            'nombre',
            'pedido',
            'comprobante',
            'enlace',
        ])
    })

    it('rejects unknown placeholders, stray braces and a misplaced {comprobante}', () => {
        expect(whatsAppTemplateError('Hola {cliente} y {x}')).toBe(
            'El mensaje de WhatsApp usa marcadores desconocidos: {cliente}, {x}. Solo se admiten {nombre}, {pedido}, {enlace}, {total}, {motivo}, {marca}, {envio}, {comprobante}.',
        )
        expect(whatsAppTemplateError('Hola {Nombre}')).toMatch(/marcador desconocido: \{Nombre\}/)
        expect(whatsAppTemplateError('Hola {nombre')).toBe(
            'Las llaves { } del mensaje de WhatsApp solo se usan para los marcadores, por ejemplo {nombre}.',
        )
        expect(whatsAppTemplateError('Ver {comprobante}', 'PENDIENTE_PAGO')).toBe(
            'El marcador {comprobante} solo se puede usar en los estados con el pago verificado.',
        )
        expect(whatsAppTemplateError('Ver {comprobante}', 'ENTREGADO')).toBeNull()
        expect(whatsAppTemplateError('Ver {comprobante}')).toBeNull()
    })

    it('turns Venezuelan mobiles into WhatsApp numbers and rejects landlines', () => {
        expect(toWhatsAppPhone('0414-1234567')).toBe('584141234567')
        expect(toWhatsAppPhone('0412 555 0134')).toBe('584125550134')
        expect(toWhatsAppPhone('+58 424-1234567')).toBe('584241234567')
        expect(toWhatsAppPhone('0058 416 1234567')).toBe('584161234567')
        expect(toWhatsAppPhone('(0426) 123-4567')).toBe('584261234567')
        expect(toWhatsAppPhone('4221234567')).toBe('584221234567')
        expect(toWhatsAppPhone('0212-5551234')).toBeNull()
        expect(toWhatsAppPhone('0414-123456')).toBeNull()
        expect(toWhatsAppPhone('0418-1234567')).toBeNull()
        expect(whatsAppUrl('584141234567', 'Hola Ana ✅ & más')).toBe(
            'https://wa.me/584141234567?text=Hola%20Ana%20%E2%9C%85%20%26%20m%C3%A1s',
        )
    })

    it('extracts the first name and drops final punctuation', () => {
        expect(firstName('  Ana María Pérez ')).toBe('Ana')
        expect(withoutFinalPunctuation('No llegó el pago. ')).toBe('No llegó el pago')
        expect(withoutFinalPunctuation('¡Listo!')).toBe('¡Listo')
    })
})
