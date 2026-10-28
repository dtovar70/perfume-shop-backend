import { caracasDay, isDateOnly } from '../../common/utils/caracas-date.js'
import type { RateCurrency } from '../rate-currency.js'
import {
    assertPlausibleRate,
    readEach,
    type ExchangeRateProvider,
    type FetchedRate,
    type ProviderRates,
} from './rate-provider.js'

/** The official (BCV) rate of each currency the mirror publishes. */
export const DOLARAPI_URLS = {
    USD: 'https://ve.dolarapi.com/v1/dolares/oficial',
    EUR: 'https://ve.dolarapi.com/v1/euros/oficial',
} as const
export type DolarApiCurrency = keyof typeof DOLARAPI_URLS
const TIMEOUT_MS = 15_000

/**
 * `GET /v1/dolares/oficial` (and `/v1/euros/oficial`, with `moneda: "EUR"`) answers
 * `{ moneda: "USD", fuente: "oficial", promedio: 854.4637, compra: null, venta: null,
 *    fechaActualizacion: "2026-09-24T00:00:00-04:00" }`.
 * `promedio` is the BCV rate and `fechaActualizacion` its fecha valor (midnight, Caracas).
 */
export function parseDolarApiJson(
    payload: unknown,
    currency: DolarApiCurrency = 'USD',
): FetchedRate {
    if (typeof payload !== 'object' || payload === null) throw new Error('DolarApi: not an object')
    const body = payload as Record<string, unknown>
    if (body.fuente !== 'oficial' || body.moneda !== currency) {
        throw new Error(`DolarApi: not the official ${currency} rate`)
    }
    const rate = assertPlausibleRate(Number(body.promedio), 'DolarApi')

    const stamp = typeof body.fechaActualizacion === 'string' ? body.fechaActualizacion : ''
    // The date part is already the Caracas day when the stamp carries the -04:00 offset;
    // otherwise convert the instant to a Caracas calendar day.
    const effectiveDate = stamp.endsWith('-04:00')
        ? stamp.slice(0, 10)
        : Number.isNaN(Date.parse(stamp))
          ? ''
          : caracasDay(new Date(stamp))
    if (!isDateOnly(effectiveDate)) throw new Error('DolarApi: invalid fechaActualizacion')

    return { rate, effectiveDate }
}

async function fetchOne(currency: DolarApiCurrency): Promise<FetchedRate> {
    const response = await fetch(DOLARAPI_URLS[currency], {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`DolarApi: HTTP ${response.status}`)
    return parseDolarApiJson(await response.json(), currency)
}

/** Public JSON mirror of the BCV rates, used when the BCV website does not answer. */
export class DolarApiProvider implements ExchangeRateProvider {
    readonly source = 'dolarapi' as const
    readonly currencies: readonly RateCurrency[] = ['USD', 'EUR']

    fetchRates(currencies: readonly RateCurrency[]): Promise<ProviderRates> {
        return readEach(currencies, (currency) => {
            if (currency !== 'USD' && currency !== 'EUR') {
                throw new Error(`DolarApi: ${currency} is not published`)
            }
            return fetchOne(currency)
        })
    }
}
