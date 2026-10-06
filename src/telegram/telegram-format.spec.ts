import {
    contactMessage,
    contactWhatsAppGreeting,
    escapeHtml,
    fitCaption,
    itemLines,
    formatCaracasDateTime,
    formatCaracasTime,
    formatDay,
    paymentMessage,
    rateSyncFailingMessage,
    rateSyncRecoveredMessage,
    TELEGRAM_TEXT_LIMIT,
    truncate,
    visibleLength,
    type PaymentMessageData,
} from './telegram-format.js'

const DATA: PaymentMessageData = {
    code: 'KZ-000012',
    customerName: 'Ana & <Co>',
    customerPhone: '0414-1234567',
    items: Array.from({ length: 8 }, (_, index) => ({
        quantity: index + 1,
        productName: index === 0 ? 'Yara <Edición>' : `Perfume ${index}`,
        variantLabel: index === 0 ? '100 ml' : null,
    })),
    totalUsd: 1234.5,
    totalBs: 1054853.41,
    exchangeRate: 854.4637,
    stockConflict: null,
    payment: {
        reference: '00123456',
        payerBankCode: '0102',
        payerBankName: 'Banco de Venezuela',
        payerPhone: '0414-1234567',
        payerIdNumber: 'V-12345678',
        paidOn: '2026-09-25',
        amountBs: 1054853.41,
        expectedBs: 1054853.41,
        duplicateReference: false,
        late: false,
        source: 'customer',
        recordedByName: null,
        hasProof: true,
    },
    adminUrl: 'https://kaizen.com/admin/pedidos/KZ-000012',
}

describe('telegram-format', () => {
    it('escapes HTML and truncates by characters', () => {
        expect(escapeHtml('<b>"A" & B</b>')).toBe('&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt;')
        expect(truncate('  abcdef  ', 4)).toBe('abc…')
        expect(truncate('✨✨✨', 3)).toBe('✨✨✨')
        expect(visibleLength('<b>a &amp; b</b>')).toBe(5)
    })

    it('lists each line with its quantity and escaped variant', () => {
        const [plain, sized] = itemLines([
            { quantity: 1, productName: 'Khamrah', variantLabel: null },
            { quantity: 2, productName: 'Sauvage', variantLabel: '<100 ml>' },
        ])
        expect(plain).toBe('• 1 × Khamrah')
        expect(sized).toBe('• 2 × Sauvage (&lt;100 ml&gt;)')
    })

    it('formats Caracas dates and times', () => {
        const date = new Date('2026-09-25T19:05:00Z')
        expect(formatCaracasTime(date)).toBe('3:05 p. m.')
        expect(formatCaracasDateTime(date)).toBe('25/09/2026, 3:05 p. m.')
        expect(formatCaracasTime(new Date('2026-09-25T04:30:00Z'))).toBe('12:30 a. m.')
        expect(formatDay('2026-09-05')).toBe('05/09/2026')
    })

    it('renders the payment with escaped customer text, money and capped items', () => {
        const text = paymentMessage(DATA)
        expect(text).toContain('🧾 <b>Nuevo pago por verificar</b> · <b>KZ-000012</b>')
        expect(text).toContain('Ana &amp; &lt;Co&gt;')
        expect(text).toContain('• 1 × Yara &lt;Edición&gt; (100 ml)')
        expect(text).toContain('…y 2 artículos más')
        expect(text).not.toContain('Perfume 6')
        expect(text).toContain('$1.234,50 · Bs. 1.054.853,41')
        expect(text).toContain('Tasa BCV 854,46')
        expect(text).toContain('Banco de Venezuela (0102)')
        expect(text).toContain('Fecha: 25/09/2026')
        expect(text).not.toContain('⚠️')
    })

    it('lists every warning', () => {
        const text = paymentMessage({
            ...DATA,
            stockConflict: {
                detectedAt: '',
                resolvedAt: null,
                resolvedById: null,
                lines: [
                    {
                        productId: 'p',
                        productName: 'Yara',
                        requested: 3,
                        available: 1,
                        reserved: 1,
                    },
                    {
                        productId: 'f',
                        variantId: 'f-m',
                        productName: 'Khamrah',
                        variantLabel: 'Talla M',
                        requested: 2,
                        available: 0,
                        reserved: 0,
                    },
                ],
            },
            payment: {
                ...DATA.payment,
                amountBs: 1054900,
                duplicateReference: true,
                late: true,
                source: 'admin',
                recordedByName: 'Dueña',
                hasProof: false,
            },
        })
        expect(text).toContain('⚠️ <b>Monto no coincide:</b> sobran Bs. 46,59')
        expect(text).toContain('⚠️ <b>Referencia repetida')
        expect(text).toContain('⏰ <b>Pago fuera de plazo</b>')
        expect(text).toContain(
            '📦 <b>Stock insuficiente:</b> «Yara» pidió 3, hay 1; «Khamrah – Talla M» pidió 2, hay 0',
        )
        expect(text).toContain('Registrado manualmente en el panel por Dueña · sin captura')
    })

    it('appends the resolution line', () => {
        expect(paymentMessage(DATA, { resolution: '✅ Hecho' }).endsWith('\n\n✅ Hecho')).toBe(true)
    })

    it('keeps captions within the limit', () => {
        expect(fitCaption(['a', 'b'], ['c'])).toBe('a\nb\nc')
        const long = 'x'.repeat(600)
        expect(fitCaption(['head'], [long, long])).toBe(`head\n${long}\n…`)
        expect(visibleLength(fitCaption(['head'], [long, long]))).toBeLessThanOrEqual(1024)
    })
})

describe('rate sync alerts', () => {
    const current = {
        rate: 36.5,
        source: 'bcv' as const,
        effectiveDate: '2026-09-25',
        usableUntil: '2026-09-26T04:00:00.000Z',
        isStale: false,
    }

    it('says both sources failed, the current rate and when orders pause', () => {
        const text = rateSyncFailingMessage({
            consecutiveFailures: 3,
            errors: [],
            current,
            at: '2026-09-25T18:00:00.000Z',
        })
        expect(text).toContain('No se pudo obtener la tasa del BCV')
        expect(text).toContain('BCV y DolarApi')
        expect(text).toContain('36,5000 Bs/$')
        expect(text).toContain('fecha valor 25/09/2026')
        expect(text).toContain('los pedidos se pausan el 26/09/2026, 12:00 a. m.')
        expect(text).toContain('Tasa BCV')
    })

    it('says orders are already paused when the rate expired or is missing', () => {
        const at = '2026-09-26T18:00:00.000Z'
        expect(
            rateSyncFailingMessage({
                consecutiveFailures: 3,
                errors: [],
                current: { ...current, isStale: true },
                at,
            }),
        ).toContain('Los pedidos ya están pausados')
        expect(
            rateSyncFailingMessage({ consecutiveFailures: 3, errors: [], current: null, at }),
        ).toContain('Todavía no hay ninguna tasa guardada')
    })

    it('announces the recovery with the rate in use', () => {
        const text = rateSyncRecoveredMessage({
            outcome: 'stored',
            failedRuns: 3,
            current,
            at: '2026-09-25T20:00:00.000Z',
        })
        expect(text).toContain('La tasa del BCV se volvió a obtener')
        expect(text).toContain('36,5000 Bs/$')
        expect(text).not.toContain('pausados')
    })
})

describe('contactMessage', () => {
    const EVENT = {
        fullName: 'Ana & <Co>',
        email: 'ana@example.com',
        phone: '0414-1234567',
        topic: 'asesoria' as const,
        message: 'Hola <b>equipo</b> & amigos',
        receivedAt: '2026-09-25T14:30:00.000Z',
    }

    it('renders who wrote, the topic label and the escaped message', () => {
        const text = contactMessage(EVENT)
        expect(text.split('\n').slice(0, 5)).toEqual([
            '📨 <b>Nuevo mensaje de contacto</b>',
            '👤 Ana &amp; &lt;Co&gt;',
            '✉️ ana@example.com',
            '📱 WhatsApp: 0414-1234567',
            '🏷️ Quiero asesoría para elegir un perfume',
        ])
        expect(text).toContain('🗓️ 25/09/2026')
        expect(text.endsWith('Hola &lt;b&gt;equipo&lt;/b&gt; &amp; amigos')).toBe(true)
    })

    it('leaves the WhatsApp line out without a phone', () => {
        expect(contactMessage({ ...EVENT, phone: null })).not.toContain('WhatsApp')
    })

    it('stays under the Telegram limit with a very long message', () => {
        const text = contactMessage({ ...EVENT, message: '<'.repeat(10_000) })
        expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
        expect(text).toContain('…')
    })

    it('greets the customer by first name', () => {
        expect(contactWhatsAppGreeting('  Ana María Pérez ')).toMatch(/^Hola Ana, te escribimos/)
        expect(contactWhatsAppGreeting('')).toMatch(/^Hola, te escribimos/)
    })
})
