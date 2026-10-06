import type { Response } from 'express'
import type { ReceiptFile } from './receipt.service.js'

/** Sends the receipt as a download (`comprobante-KZ-000012.pdf`), never cached. */
export function sendReceipt(res: Response, file: ReceiptFile): void {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', String(file.content.length))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(file.content)
}
