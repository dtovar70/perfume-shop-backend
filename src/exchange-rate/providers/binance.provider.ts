import { caracasDay } from '../../common/utils/caracas-date.js'
import type { RateCurrency } from '../rate-currency.js'
import {
    assertPlausibleRate,
    type ExchangeRateProvider,
    type FetchedRate,
    type ProviderRates,
} from './rate-provider.js'

/**
 * The public search behind the Binance P2P web page. Binance offers no official P2P API: this
 * endpoint is unofficial, may change without notice and may rate-limit or block datacenter IPs.
 */
export const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search'
/** Ads of people selling USDT for bolívares (what a buyer pays), first page. */
export const BINANCE_P2P_QUERY = {
    asset: 'USDT',
    fiat: 'VES',
    tradeType: 'BUY',
    page: 1,
    rows: 10,
    payTypes: [],
    publisherType: null,
} as const
const TIMEOUT_MS = 15_000
/** Fewer ads than this is not a market price. */
export const BINANCE_MIN_ADS = 3

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * `{ code: "000000", success: true, data: [{ adv: { asset: "USDT", fiatUnit: "VES",
 * price: "1006.500", … }, advertiser: {…} }, …] }`. The rate is the median of the ads' prices
 * (one odd ad cannot move it); its fecha valor is the day it was read (Caracas).
 */
export function parseBinanceP2pJson(payload: unknown, now = new Date()): FetchedRate {
    if (typeof payload !== 'object' || payload === null) throw new Error('Binance: not an object')
    const body = payload as Record<string, unknown>
    if (body.code !== '000000' || !Array.isArray(body.data)) {
        throw new Error(`Binance: unexpected answer (code ${String(body.code)})`)
    }
    const prices: number[] = []
    for (const entry of body.data as unknown[]) {
        const adv = (entry as { adv?: Record<string, unknown> } | null)?.adv
        if (!adv || adv.asset !== 'USDT' || adv.fiatUnit !== 'VES') continue
        const price = Number(adv.price)
        if (!Number.isFinite(price) || price <= 0) throw new Error('Binance: invalid ad price')
        prices.push(price)
    }
    if (prices.length < BINANCE_MIN_ADS) {
        throw new Error(`Binance: only ${prices.length} ads (need ${BINANCE_MIN_ADS})`)
    }
    return { rate: assertPlausibleRate(median(prices), 'Binance'), effectiveDate: caracasDay(now) }
}

/** USDT in bolívares from the Binance P2P market (an unofficial reference, updated often). */
export class BinanceProvider implements ExchangeRateProvider {
    readonly source = 'binance' as const
    readonly currencies: readonly RateCurrency[] = ['USDT']

    async fetchRates(currencies: readonly RateCurrency[]): Promise<ProviderRates> {
        if (!currencies.includes('USDT')) return {}
        const response = await fetch(BINANCE_P2P_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent':
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            },
            body: JSON.stringify(BINANCE_P2P_QUERY),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`Binance: HTTP ${response.status}`)
        return { USDT: parseBinanceP2pJson(await response.json()) }
    }
}
