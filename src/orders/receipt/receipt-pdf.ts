import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import { formatBs, formatUsd, formatVeNumber } from '../../common/utils/money-format.js'

/** Everything printed on the receipt, already resolved (labels, Caracas dates as text). */
export interface ReceiptData {
    /** PNG of the QR to the customer's order page; null or missing prints no QR. */
    orderQr?: Buffer | null
    brandName: string
    tagline: string
    contact: { phone: string; whatsapp: string; email: string; city: string; instagram: string }
    code: string
    /** "25/09/2026, 10:42 a. m." (Caracas). */
    issuedAt: string
    verifiedAt: string | null
    statusLabel: string
    customer: { name: string; email: string; phone: string }
    delivery: { method: string; address: string }
    items: {
        name: string
        variant: string | null
        quantity: number
        unitUsd: number
        totalUsd: number
    }[]
    subtotalUsd: number
    shippingUsd: number
    totalUsd: number
    exchangeRate: number
    /** "24/09/2026". */
    exchangeRateDate: string
    exchangeRateSource: string
    totalBs: number
    payment: {
        bankName: string
        reference: string
        payerPhone: string
        paidOn: string
        amountBs: number
    }
}

export const RECEIPT_DISCLAIMER =
    'Este documento es un comprobante de compra y no sustituye una factura fiscal.'

/**
 * `src/assets` (tsx, tests) or `dist/assets` (after `nest build`, which copies them: see the
 * `assets` entry of nest-cli.json). This file lives two folders below either root.
 */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets')

const FONT_FILES = {
    regular: 'fonts/PlusJakartaSans-Regular.ttf',
    semibold: 'fonts/PlusJakartaSans-SemiBold.ttf',
    bold: 'fonts/PlusJakartaSans-Bold.ttf',
    display: 'fonts/Fredoka-SemiBold.ttf',
} as const

/** Built-in PDF fonts, used if a TTF is missing (they lack "–" and a few other glyphs). */
const FALLBACK_FONTS: Record<keyof typeof FONT_FILES, string> = {
    regular: 'Helvetica',
    semibold: 'Helvetica-Bold',
    bold: 'Helvetica-Bold',
    display: 'Helvetica-Bold',
}

const LOGO_FILE = 'images/logo-mark.png'

const COLOR = {
    ink: '#2e2438',
    soft: '#6b5f78',
    line: '#f0e4ec',
    pink: '#e75f9b',
    pinkDark: '#c44a80',
    blush: '#fff5f9',
    blushStrong: '#ffe7f1',
    mint: '#1f7a55',
    mintBg: '#e3f7ee',
} as const

type FontKey = keyof typeof FONT_FILES
type Doc = PDFKit.PDFDocument

const PAGE_MARGIN = 48
const FOOTER_HEIGHT = 56

/**
 * Customer text may hold emoji, which the embedded fonts cannot draw (they would print as empty
 * boxes): they are dropped, the rest (accents, ñ, "–", "·") is kept.
 */
export function printable(text: string): string {
    return text
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}|\p{Emoji_Modifier}/gu, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
}

/** Registers the brand fonts, falling back to the built-in ones when a file is missing. */
function registerFonts(doc: Doc): Record<FontKey, string> {
    const names = {} as Record<FontKey, string>
    for (const key of Object.keys(FONT_FILES) as FontKey[]) {
        const path = join(ASSETS_DIR, FONT_FILES[key])
        if (existsSync(path)) {
            doc.registerFont(key, path)
            names[key] = key
        } else {
            names[key] = FALLBACK_FONTS[key]
        }
    }
    return names
}

/** Renders the "Comprobante de compra" (A4) and resolves with the PDF bytes. */
export function renderReceiptPdf(data: ReceiptData): Promise<Buffer> {
    const doc = new PDFDocument({
        size: 'A4',
        margins: {
            top: PAGE_MARGIN,
            left: PAGE_MARGIN,
            right: PAGE_MARGIN,
            bottom: PAGE_MARGIN + FOOTER_HEIGHT,
        },
        bufferPages: true,
        info: {
            Title: `Comprobante de compra ${data.code}`,
            Author: data.brandName,
            Subject: 'Comprobante de compra',
        },
    })
    const chunks: Buffer[] = []
    const done = new Promise<Buffer>((resolve, reject) => {
        doc.on('data', (chunk: Buffer) => chunks.push(chunk))
        doc.on('end', () => resolve(Buffer.concat(chunks)))
        doc.on('error', reject)
    })

    new ReceiptLayout(doc, registerFonts(doc), data).draw()
    doc.end()
    return done
}

class ReceiptLayout {
    private readonly left = PAGE_MARGIN
    private readonly width: number

    constructor(
        private readonly doc: Doc,
        private readonly fonts: Record<FontKey, string>,
        private readonly data: ReceiptData,
    ) {
        this.width = doc.page.width - PAGE_MARGIN * 2
    }

    draw(): void {
        this.header()
        this.parties()
        this.itemsTable()
        this.totalsAndPayment()
        this.trackingQr()
        this.footers()
    }

    private get bottom(): number {
        return this.doc.page.height - this.doc.page.margins.bottom
    }

    private font(key: FontKey, size: number, color: string = COLOR.ink): Doc {
        return this.doc.font(this.fonts[key]).fontSize(size).fillColor(color)
    }

    /** Starts a new page when `height` does not fit below the cursor. */
    private ensureSpace(height: number): void {
        if (this.doc.y + height > this.bottom) {
            this.doc.addPage()
            this.doc.y = PAGE_MARGIN
        }
    }

    private header(): void {
        const { doc, data, left, width } = this
        const top = PAGE_MARGIN
        const logo = join(ASSETS_DIR, LOGO_FILE)
        const logoSize = 58
        if (existsSync(logo)) {
            // Rounded corners, like the logo on the storefront.
            doc.save()
            doc.roundedRect(left, top - 4, logoSize, logoSize, 14).clip()
            doc.image(logo, left, top - 4, { width: logoSize, height: logoSize })
            doc.restore()
        }
        const textLeft = left + logoSize + 12

        this.font('display', 19).text(printable(data.brandName), textLeft, top + 6, {
            width: 240,
            lineBreak: false,
        })
        this.font('regular', 9, COLOR.soft).text(printable(data.tagline), textLeft, top + 31, {
            width: 240,
            lineBreak: false,
        })

        const rightWidth = 220
        const rightLeft = left + width - rightWidth
        this.font('display', 17, COLOR.pinkDark).text('Comprobante de compra', rightLeft, top + 2, {
            width: rightWidth,
            align: 'right',
        })
        this.font('bold', 13).text(data.code, rightLeft, top + 25, {
            width: rightWidth,
            align: 'right',
        })
        this.font('regular', 8.5, COLOR.soft).text(
            `Emitido: ${data.issuedAt}`,
            rightLeft,
            top + 43,
            {
                width: rightWidth,
                align: 'right',
            },
        )

        const lineY = top + logoSize + 12
        doc.moveTo(left, lineY)
            .lineTo(left + width, lineY)
            .lineWidth(2)
            .strokeColor(COLOR.pink)
            .stroke()
        doc.y = lineY + 16
    }

    /** "Cliente" and "Entrega" side by side, as soft cards. */
    private parties(): void {
        const { data, left, width } = this
        const gap = 14
        const cardWidth = (width - gap) / 2
        const top = this.doc.y
        const customer: [string, string][] = [
            ['Nombre', data.customer.name],
            ['Correo', data.customer.email],
            ['Teléfono', data.customer.phone],
        ]
        const delivery: [string, string][] = [
            ['Método', data.delivery.method],
            ['Dirección', data.delivery.address],
        ]
        const height = Math.max(
            this.cardHeight(customer, cardWidth),
            this.cardHeight(delivery, cardWidth),
        )
        this.card('Cliente', customer, left, top, cardWidth, height)
        this.card('Entrega', delivery, left + cardWidth + gap, top, cardWidth, height)
        this.doc.y = top + height + 18
    }

    private cardHeight(rows: [string, string][], width: number): number {
        const inner = width - 24 - 62
        this.font('regular', 9)
        const body = rows.reduce(
            (sum, [, value]) =>
                sum +
                Math.max(12, this.doc.heightOfString(printable(value) || '—', { width: inner })) +
                4,
            0,
        )
        return 30 + body + 6
    }

    private card(
        title: string,
        rows: [string, string][],
        x: number,
        y: number,
        width: number,
        height: number,
    ): void {
        const { doc } = this
        doc.roundedRect(x, y, width, height, 8).fillColor(COLOR.blush).fill()
        this.font('display', 11, COLOR.pinkDark).text(title, x + 12, y + 10, {
            width: width - 24,
            lineBreak: false,
        })
        let rowY = y + 30
        const labelWidth = 62
        for (const [label, value] of rows) {
            this.font('semibold', 8.5, COLOR.soft).text(label, x + 12, rowY, {
                width: labelWidth,
                lineBreak: false,
            })
            this.font('regular', 9).text(printable(value) || '—', x + 12 + labelWidth, rowY, {
                width: width - 24 - labelWidth,
            })
            rowY = Math.max(doc.y, rowY + 12) + 4
        }
    }

    private readonly columns = [
        { key: 'name', label: 'Producto', width: 200, align: 'left' },
        { key: 'variant', label: 'Presentación', width: 119, align: 'left' },
        { key: 'quantity', label: 'Cant.', width: 36, align: 'center' },
        { key: 'unit', label: 'P. unitario', width: 70, align: 'right' },
        { key: 'total', label: 'Total', width: 74, align: 'right' },
    ] as const

    private tableHeader(): void {
        const { doc, left, width } = this
        const y = doc.y
        doc.roundedRect(left, y, width, 22, 5).fillColor(COLOR.blushStrong).fill()
        let x = left
        for (const column of this.columns) {
            this.font('semibold', 8.5, COLOR.pinkDark).text(column.label, x + 6, y + 7, {
                width: column.width - 12,
                align: column.align,
                lineBreak: false,
            })
            x += column.width
        }
        doc.y = y + 26
    }

    private itemsTable(): void {
        const { doc, data, left, width } = this
        this.sectionTitle('Productos')
        this.tableHeader()

        for (const item of data.items) {
            const cells: Record<(typeof this.columns)[number]['key'], string> = {
                name: printable(item.name),
                variant: item.variant ? printable(item.variant) : '—',
                quantity: String(item.quantity),
                unit: formatUsd(item.unitUsd),
                total: formatUsd(item.totalUsd),
            }
            this.font('regular', 9)
            const height =
                Math.max(
                    ...this.columns.map((column) =>
                        doc.heightOfString(cells[column.key], { width: column.width - 12 }),
                    ),
                ) + 12
            if (doc.y + height > this.bottom) {
                doc.addPage()
                doc.y = PAGE_MARGIN
                this.tableHeader()
            }
            const y = doc.y
            let x = left
            for (const column of this.columns) {
                const key: FontKey =
                    column.key === 'name' || column.key === 'total' ? 'semibold' : 'regular'
                const color = column.key === 'variant' ? COLOR.soft : COLOR.ink
                this.font(key, 9, color).text(cells[column.key], x + 6, y + 6, {
                    width: column.width - 12,
                    align: column.align,
                })
                x += column.width
            }
            doc.moveTo(left, y + height)
                .lineTo(left + width, y + height)
                .lineWidth(0.75)
                .strokeColor(COLOR.line)
                .stroke()
            doc.y = y + height
        }
        doc.y += 14
    }

    private sectionTitle(title: string): void {
        this.ensureSpace(60)
        this.font('display', 12, COLOR.ink).text(title, this.left, this.doc.y, {
            width: this.width,
        })
        this.doc.y += 4
    }

    /** Payment details (left) and totals (right). Kept together on one page. */
    private totalsAndPayment(): void {
        const { doc, data, left, width } = this
        const gap = 16
        const totalsWidth = 228
        const paymentWidth = width - totalsWidth - gap
        const totals: [string, string, 'normal' | 'strong' | 'soft'][] = [
            ['Subtotal', formatUsd(data.subtotalUsd), 'normal'],
            ['Envío', data.shippingUsd > 0 ? formatUsd(data.shippingUsd) : 'Gratis', 'normal'],
            ['Total USD', formatUsd(data.totalUsd), 'strong'],
            ['Tasa BCV', `${formatVeNumber(data.exchangeRate, 4)} Bs./USD`, 'soft'],
            ['Fecha de la tasa', `${data.exchangeRateDate} · ${data.exchangeRateSource}`, 'soft'],
        ]
        const payment: [string, string][] = [
            ['Banco', data.payment.bankName],
            ['Referencia', data.payment.reference],
            ['Teléfono pagador', data.payment.payerPhone],
            ['Fecha del pago', data.payment.paidOn],
            ['Monto pagado', formatBs(data.payment.amountBs)],
            ['Verificado', data.verifiedAt ?? '—'],
        ]
        const blockHeight = 30 + payment.length * 17 + 40
        this.ensureSpace(blockHeight + 40)
        const top = doc.y

        // Payment card.
        doc.roundedRect(left, top, paymentWidth, blockHeight, 8).fillColor(COLOR.blush).fill()
        this.font('display', 11, COLOR.pinkDark).text('Pago Móvil', left + 12, top + 10, {
            width: paymentWidth - 24,
            lineBreak: false,
        })
        const badge = 'Pago verificado'
        this.font('semibold', 8)
        const badgeWidth = doc.widthOfString(badge) + 16
        doc.roundedRect(left + paymentWidth - 12 - badgeWidth, top + 9, badgeWidth, 16, 8)
            .fillColor(COLOR.mintBg)
            .fill()
        this.font('semibold', 8, COLOR.mint).text(
            badge,
            left + paymentWidth - 12 - badgeWidth,
            top + 13,
            { width: badgeWidth, align: 'center', lineBreak: false },
        )
        let rowY = top + 34
        for (const [label, value] of payment) {
            this.font('semibold', 8.5, COLOR.soft).text(label, left + 12, rowY, {
                width: 96,
                lineBreak: false,
            })
            this.font('regular', 9).text(printable(value), left + 112, rowY, {
                width: paymentWidth - 124,
                lineBreak: false,
                ellipsis: true,
            })
            rowY += 17
        }
        this.font('semibold', 8.5, COLOR.soft).text('Estado actual', left + 12, rowY + 6, {
            width: 96,
            lineBreak: false,
        })
        this.font('bold', 9, COLOR.pinkDark).text(
            printable(data.statusLabel),
            left + 112,
            rowY + 6,
            {
                width: paymentWidth - 124,
                lineBreak: false,
            },
        )

        // Totals.
        const x = left + paymentWidth + gap
        let y = top + 4
        for (const [label, value, tone] of totals) {
            const size = tone === 'strong' ? 11 : tone === 'soft' ? 8.5 : 9.5
            const color = tone === 'soft' ? COLOR.soft : COLOR.ink
            this.font(tone === 'strong' ? 'bold' : 'regular', size, color).text(label, x, y, {
                width: 100,
                lineBreak: false,
            })
            this.font(tone === 'strong' ? 'bold' : 'semibold', size, color).text(value, x + 92, y, {
                width: totalsWidth - 92,
                align: 'right',
                lineBreak: false,
            })
            y += tone === 'strong' ? 22 : 18
            if (tone === 'strong') {
                doc.moveTo(x, y - 6)
                    .lineTo(x + totalsWidth, y - 6)
                    .lineWidth(0.75)
                    .strokeColor(COLOR.line)
                    .stroke()
            }
        }
        const bsTop = top + blockHeight - 48
        doc.roundedRect(x, bsTop, totalsWidth, 48, 8).fillColor(COLOR.pink).fill()
        this.font('semibold', 8.5, '#ffffff').text('Total en bolívares', x + 12, bsTop + 9, {
            width: totalsWidth - 24,
            lineBreak: false,
        })
        this.font('bold', 16, '#ffffff').text(formatBs(data.totalBs), x + 12, bsTop + 22, {
            width: totalsWidth - 24,
            align: 'right',
            lineBreak: false,
        })
        doc.y = top + blockHeight + 18
    }

    /**
     * "Escanea para ver el estado de tu pedido": a small card under the totals with the QR of
     * the customer's private order link (about 76 pt, black on white, quiet zone included).
     */
    private trackingQr(): void {
        const { doc, data, left, width } = this
        if (!data.orderQr) return
        const cardWidth = 228
        const cardHeight = 92
        const qrSize = 76
        this.ensureSpace(cardHeight + 8)
        const top = doc.y - 4
        const x = left + width - cardWidth
        doc.roundedRect(x, top, cardWidth, cardHeight, 8)
            .lineWidth(1)
            .strokeColor(COLOR.blushStrong)
            .stroke()
        // The PNG carries its own white quiet zone; the card only frames it.
        doc.image(data.orderQr, x + 8, top + (cardHeight - qrSize) / 2, {
            width: qrSize,
            height: qrSize,
        })
        const textLeft = x + 8 + qrSize + 8
        const textWidth = cardWidth - (textLeft - x) - 10
        this.font('display', 11, COLOR.pinkDark).text('Sigue tu pedido', textLeft, top + 16, {
            width: textWidth,
            lineBreak: false,
        })
        this.font('semibold', 8.5, COLOR.ink).text(
            'Escanea para ver el estado de tu pedido',
            textLeft,
            top + 33,
            { width: textWidth },
        )
        this.font('regular', 7.5, COLOR.soft).text(
            'Es tu enlace privado: no lo compartas.',
            textLeft,
            doc.y + 4,
            { width: textWidth },
        )
        doc.y = top + cardHeight + 18
    }

    /** Disclaimer, contact and page number at the bottom of every page. */
    private footers(): void {
        const { doc, data, left, width } = this
        const range = doc.bufferedPageRange()
        const contact = [
            data.contact.whatsapp ? `WhatsApp ${data.contact.whatsapp}` : '',
            data.contact.email,
            data.contact.instagram ? `@${data.contact.instagram}` : '',
            data.contact.city,
        ]
            .map(printable)
            .filter(Boolean)
            .join('  ·  ')
        for (let index = range.start; index < range.start + range.count; index++) {
            doc.switchToPage(index)
            // Writing inside the bottom margin would open a new page: lift it while drawing.
            const margin = doc.page.margins.bottom
            doc.page.margins.bottom = 0
            const y = doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT + 14
            doc.moveTo(left, y)
                .lineTo(left + width, y)
                .lineWidth(0.75)
                .strokeColor(COLOR.line)
                .stroke()
            this.font('semibold', 8, COLOR.ink).text(RECEIPT_DISCLAIMER, left, y + 9, {
                width,
                align: 'center',
                lineBreak: false,
            })
            this.font('regular', 8, COLOR.soft).text(contact, left, y + 22, {
                width,
                align: 'center',
                lineBreak: false,
            })
            this.font('regular', 7.5, COLOR.soft).text(
                `${data.code} · Página ${index - range.start + 1} de ${range.count}`,
                left,
                y + 35,
                { width, align: 'center', lineBreak: false },
            )
            doc.page.margins.bottom = margin
        }
    }
}
