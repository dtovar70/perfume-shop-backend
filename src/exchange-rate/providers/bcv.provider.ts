import { request } from 'node:https'
import { rootCertificates } from 'node:tls'
import { isDateOnly } from '../../common/utils/caracas-date.js'
import { SECTIGO_DV_R36_PEM } from './bcv-ca.js'
import type { RateCurrency } from '../rate-currency.js'
import {
    assertPlausibleRate,
    readEach,
    type ExchangeRateProvider,
    type FetchedRate,
    type ProviderRates,
} from './rate-provider.js'

export const BCV_URL = 'https://www.bcv.org.ve/'
const TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 3 * 1024 * 1024

/**
 * Node's own roots plus the intermediate the BCV forgets to send. Passed per request (never
 * through a global agent or NODE_TLS_REJECT_UNAUTHORIZED), so nothing else is affected.
 */
const BCV_TRUSTED_CAS = [...rootCertificates, SECTIGO_DV_R36_PEM.trim()]

/** "854,46370000" (Venezuelan format) -> 854.4637 */
function parseVeNumber(text: string): number {
    const normalized = text.trim().replace(/\./g, '').replace(',', '.')
    return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN
}

/** The `<div id="…">` block of each currency on the BCV home page. */
const BCV_BLOCK_IDS = { USD: 'dolar', EUR: 'euro' } as const
export type BcvCurrency = keyof typeof BCV_BLOCK_IDS

/**
 * Reads a rate and its "fecha valor" from the BCV home page. Each rate sits in its own block
 * (`<div id="dolar">`, `<div id="euro">`: `<strong>854,46370000</strong>`), and the date in the
 * `Fecha Valor: <span … content="2026-09-24T00:00:00-04:00">` that follows all the rates.
 */
export function parseBcvHtml(html: string, currency: BcvCurrency = 'USD'): FetchedRate {
    const blockStart = html.indexOf(`id="${BCV_BLOCK_IDS[currency]}"`)
    if (blockStart < 0) throw new Error(`BCV: ${currency} block not found`)
    const afterBlock = html.slice(blockStart)

    const rateMatch = /<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/.exec(afterBlock)
    if (!rateMatch?.[1]) throw new Error(`BCV: ${currency} rate not found`)
    const rate = assertPlausibleRate(parseVeNumber(rateMatch[1]), 'BCV')

    const dateMatch = /Fecha\s+Valor:[\s\S]{0,200}?content="(\d{4}-\d{2}-\d{2})T/.exec(afterBlock)
    const effectiveDate = dateMatch?.[1]
    if (!effectiveDate || !isDateOnly(effectiveDate)) throw new Error('BCV: fecha valor not found')

    return { rate, effectiveDate }
}

function download(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = request(
            url,
            {
                method: 'GET',
                ca: BCV_TRUSTED_CAS,
                timeout: TIMEOUT_MS,
                headers: { 'User-Agent': 'KaiZen/1.0 (+tasa BCV)', Accept: 'text/html' },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume()
                    reject(new Error(`BCV: HTTP ${String(res.statusCode)}`))
                    return
                }
                const chunks: Buffer[] = []
                let size = 0
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length
                    if (size > MAX_BODY_BYTES) {
                        req.destroy(new Error('BCV: response too large'))
                        return
                    }
                    chunks.push(chunk)
                })
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
                res.on('error', reject)
            },
        )
        req.on('timeout', () => req.destroy(new Error('BCV: request timed out')))
        req.on('error', reject)
        req.end()
    })
}

/** The official source: the BCV website (dollar and euro from one download). */
export class BcvProvider implements ExchangeRateProvider {
    readonly source = 'bcv' as const
    readonly currencies: readonly RateCurrency[] = ['USD', 'EUR']

    async fetchRates(currencies: readonly RateCurrency[]): Promise<ProviderRates> {
        const html = await download(BCV_URL)
        return readEach(currencies, (currency) => {
            if (currency !== 'USD' && currency !== 'EUR') {
                throw new Error(`BCV: ${currency} is not published`)
            }
            return parseBcvHtml(html, currency)
        })
    }
}
