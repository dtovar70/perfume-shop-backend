import { orderQrPng } from '../qr/order-qr.js'
import { printable, renderReceiptPdf, type ReceiptData } from './receipt-pdf.js'

function receipt(items: number): ReceiptData {
    return {
        brandName: 'KaiZen',
        tagline: 'Perfumería de autor',
        contact: {
            phone: '0414-5086536',
            whatsapp: '0414-5086536',
            email: 'hola@kaizen.com',
            city: 'Caracas',
            instagram: 'kaizen.perfumeria',
        },
        code: 'KZ-000012',
        issuedAt: '25/09/2026, 10:42 a. m.',
        verifiedAt: '24/09/2026, 3:05 p. m.',
        statusLabel: 'En producción',
        customer: { name: 'Ana María Pérez', email: 'ana@example.com', phone: '0414-1234567' },
        delivery: { method: 'Envío a domicilio', address: 'Av. Principal, casa 4, Caracas' },
        items: Array.from({ length: items }, (_, index) => ({
            name:
                index % 2
                    ? `Lattafa Yara Ñandú ${index + 1} – Edición ✨`
                    : `Dior Sauvage ${index + 1}`,
            variant: '100 ml',
            quantity: 2,
            unitUsd: 16,
            totalUsd: 32,
        })),
        subtotalUsd: 32 * items,
        shippingUsd: 0,
        totalUsd: 32 * items,
        exchangeRate: 854.4637,
        exchangeRateDate: '24/09/2026',
        exchangeRateSource: 'BCV (bcv.org.ve)',
        totalBs: 27342.84 * items,
        payment: {
            bankName: 'Banco de Venezuela',
            reference: '00123456',
            payerPhone: '0414-1234567',
            paidOn: '24/09/2026',
            amountBs: 27342.84 * items,
        },
    }
}

/** Number of `/Type /Page` objects (pages, not the `/Pages` tree). */
function pageCount(pdf: Buffer): number {
    return pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g)?.length ?? 0
}

describe('receipt PDF', () => {
    it('renders a one-page A4 PDF with the embedded brand fonts', async () => {
        const pdf = await renderReceiptPdf(receipt(3))
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
        expect(pageCount(pdf)).toBe(1)
        const raw = pdf.toString('latin1')
        expect(raw).toContain('PlusJakartaSans')
        expect(raw).toContain('Fredoka')
        expect(raw).toContain('/MediaBox [0 0 595.28 841.89]')
    })

    it('prints the order QR next to the totals and stays on one page', async () => {
        const plain = await renderReceiptPdf(receipt(3))
        const withQr = await renderReceiptPdf({
            ...receipt(3),
            orderQr: await orderQrPng('https://kaizen.com/pedido/KZ-000012?t=abc', 360),
        })
        const images = (pdf: Buffer) =>
            pdf.toString('latin1').match(/\/Subtype \/Image/g)?.length ?? 0
        expect(images(withQr)).toBe(images(plain) + 1)
        expect(pageCount(withQr)).toBe(1)
    })

    it('paginates long item lists', async () => {
        const pdf = await renderReceiptPdf(receipt(40))
        expect(pageCount(pdf)).toBeGreaterThan(1)
    })

    it('drops emoji the fonts cannot draw but keeps Spanish text', () => {
        expect(printable('¡Feliz día, Begoña! 🎉 – ✅ «ñ» · 👍🏽')).toBe(
            '¡Feliz día, Begoña! – «ñ» ·',
        )
    })
})
