import type { ContactContent, PaymentContent } from '../../content/content.types.js'
import { orderLinkEmail, orderReceivedEmail, type OrderReceivedData } from './order-emails.js'

const CONTACT: ContactContent = {
    email: 'hola@kaizen.com',
    phone: '0414-5086536',
    whatsapp: '0414-5086536',
    city: 'Caracas',
    schedule: '',
    instagram: 'kaizen.perfumeria',
    tiktok: '',
}
const SHOP = { brandName: 'KaiZen', contact: CONTACT }
const PAYMENT: PaymentContent = {
    bankCode: '0134',
    bankName: 'Banesco',
    phone: '0412-5550134',
    idNumber: 'V-12345678',
    holderName: 'KaiZen C.A.',
    instructions: 'Envía la captura desde tu pedido.',
}
const LINK = 'https://kaizen.com/pedido/KZ-000123?t=tok_en'

const ORDER: OrderReceivedData = {
    code: 'KZ-000123',
    customerName: 'Ana María <Pérez>',
    deliveryMethod: 'delivery',
    address: 'Av. Principal, casa 4',
    city: 'Caracas',
    subtotalUsd: 32,
    shippingUsd: 4,
    totalUsd: 36,
    totalBs: 30760.69,
    exchangeRate: 854.4637,
    exchangeRateDate: '2026-09-25',
    // 11:05 a. m. in Caracas (UTC-4).
    paymentDueAt: new Date('2026-09-26T15:05:00Z'),
    items: [
        {
            productName: 'Versace Eros',
            variantLabel: '100 ml',
            quantity: 1,
            unitPriceUsd: 20,
            lineTotalUsd: 20,
            sortOrder: 1,
        },
        {
            productName: 'Lattafa Yara <b>Ñandú</b>',
            variantLabel: '50 ml',
            quantity: 2,
            unitPriceUsd: 6,
            lineTotalUsd: 12,
            sortOrder: 0,
        },
    ],
}

describe('order emails', () => {
    it('"Pedido recibido" has the items, totals, Pago Móvil data, deadline, delivery and link', () => {
        const email = orderReceivedEmail(ORDER, PAYMENT, LINK, SHOP)
        expect(email.subject).toBe('Recibimos tu pedido KZ-000123')

        const { text, html } = email
        expect(text).toContain('¡GRACIAS POR TU PEDIDO, ANA!')
        expect(text).toContain('Recibimos tu pedido KZ-000123 y ya lo apartamos para ti.')
        // Items in their order, with variant and quantity.
        expect(text.indexOf('Lattafa Yara <b>Ñandú</b> · 50 ml')).toBeLessThan(
            text.indexOf('Versace Eros · 100 ml'),
        )
        expect(text).toContain(
            '- Lattafa Yara <b>Ñandú</b> · 50 ml — $12,00\n  Cantidad: 2 × $6,00\n',
        )
        expect(text).toContain(
            'Subtotal: $32,00\nEnvío: $4,00\nTotal: $36,00\nTotal en bolívares: Bs. 30.760,69',
        )
        expect(text).toContain('Tasa BCV del 25/09/2026: 854,4637 Bs/$')
        expect(text).toContain(
            'Datos para tu Pago Móvil\nBanco: 0134 - Banesco\nTeléfono: 0412-5550134\nCédula / RIF: V-12345678\nTitular: KaiZen C.A.\nMonto exacto: Bs. 30.760,69\nConcepto: Pedido KZ-000123',
        )
        expect(text).toContain('Envía la captura desde tu pedido.')
        expect(text).toContain(
            'Tienes hasta el 26/09/2026, 11:05 a. m. (hora de Venezuela) para pagar',
        )
        expect(text).toContain(
            'Entrega\nMétodo: Envío a domicilio\nDirección: Av. Principal, casa 4, Caracas',
        )
        expect(text).toContain(`Ver mi pedido: ${LINK}`)
        expect(text).toContain('WhatsApp (0414-5086536) (https://wa.me/584145086536)')

        expect(html).toContain('&lt;b&gt;Ñandú&lt;/b&gt;')
        expect(html).not.toContain('<b>Ñandú</b>')
        expect(html).toContain(`href="${LINK}"`)
        expect(html).toContain('Ver mi pedido')
    })

    it('pickup has no address or shipping cost; without Pago Móvil data it asks to write', () => {
        const { text } = orderReceivedEmail(
            { ...ORDER, deliveryMethod: 'pickup', shippingUsd: 0 },
            null,
            LINK,
            { ...SHOP, contact: { ...CONTACT, whatsapp: '' } },
        )
        expect(text).toContain('Envío: Sin costo (retiro)')
        expect(text).toContain('Método: Retiro en tienda')
        expect(text).not.toContain('Dirección:')
        expect(text).not.toContain('Datos para tu Pago Móvil')
        expect(text).toContain('Escríbenos para coordinar tu pago')
        expect(text).toContain('Responde este correo y con gusto te ayudamos.')
    })

    it('"Consultar mi pedido" sends the link', () => {
        const email = orderLinkEmail({ code: 'KZ-000123', customerName: 'Ana Pérez' }, LINK, SHOP)
        expect(email.subject).toBe('Tu enlace para ver el pedido KZ-000123')
        expect(email.text).toContain('Nos pediste el enlace de tu pedido KZ-000123.')
        expect(email.text).toContain(`Ver mi pedido: ${LINK}`)
        expect(email.html).toContain(`href="${LINK}"`)
    })
})
