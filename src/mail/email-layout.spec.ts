import type { ContactContent } from '../content/content.types.js'
import { contactLinks, escapeHtml, renderEmail } from './email-layout.js'

const CONTACT: ContactContent = {
    email: 'hola@kaizen.com',
    phone: '0414-5086536',
    whatsapp: '0414-5086536',
    city: 'Caracas',
    schedule: '',
    instagram: 'kaizen.perfumeria',
    tiktok: '',
}

describe('email layout', () => {
    it('escapes every value in the HTML and keeps it readable in the text part', () => {
        const { html, text } = renderEmail({
            brandName: 'Kai <Zen>',
            contact: CONTACT,
            preheader: 'Hola & bienvenida',
            blocks: [
                { kind: 'heading', text: '¡Hola, <script>alert(1)</script>!' },
                { kind: 'paragraph', parts: ['Tu pedido ', { bold: 'KZ-000001' }, ' "llegó"'] },
                {
                    kind: 'items',
                    items: [
                        { title: 'Yara <b>', details: ['Presentación: “<img>”'], amount: '$1' },
                    ],
                },
                {
                    kind: 'rows',
                    title: 'Pago',
                    rows: [{ label: 'Monto', value: 'Bs. 1,00', strong: true }],
                },
                {
                    kind: 'button',
                    href: 'https://tienda.test/pedido/KZ-000001?t=a&b',
                    label: 'Ver mi pedido',
                },
            ],
        })
        expect(html).not.toContain('<script>')
        expect(html).not.toContain('<img>')
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
        expect(html).toContain('Kai &lt;Zen&gt;')
        expect(html).toContain('<strong>KZ-000001</strong> &quot;llegó&quot;')
        expect(html).toContain('href="https://tienda.test/pedido/KZ-000001?t=a&amp;b"')
        expect(html).toContain('lang="es"')

        expect(text).toContain('¡HOLA, <SCRIPT>ALERT(1)</SCRIPT>!')
        expect(text).toContain('Tu pedido KZ-000001 "llegó"')
        expect(text).toContain('- Yara <b> — $1\n  Presentación: “<img>”')
        expect(text).toContain('Pago\nMonto: Bs. 1,00')
        expect(text).toContain('Ver mi pedido: https://tienda.test/pedido/KZ-000001?t=a&b')
        expect(text).toContain('--\nKai <Zen>\nhola@kaizen.com: mailto:hola@kaizen.com')
    })

    it('never turns a non-web link into an href', () => {
        const { html } = renderEmail({
            brandName: 'Tienda',
            contact: CONTACT,
            preheader: '',
            blocks: [{ kind: 'button', href: 'javascript:alert(1)', label: 'X' }],
        })
        expect(html).not.toContain('javascript:')
    })

    it('lists only the contact data that is set', () => {
        expect(contactLinks(CONTACT)).toEqual([
            { label: 'hola@kaizen.com', href: 'mailto:hola@kaizen.com' },
            { label: 'WhatsApp 0414-5086536', href: 'https://wa.me/584145086536' },
            {
                label: 'Instagram @kaizen.perfumeria',
                href: 'https://instagram.com/kaizen.perfumeria',
            },
        ])
        expect(
            contactLinks({ ...CONTACT, email: ' ', whatsapp: '0212-5551234', instagram: '' }),
        ).toEqual([])
        expect(escapeHtml(`<a href='x'>&</a>`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;')
    })
})
