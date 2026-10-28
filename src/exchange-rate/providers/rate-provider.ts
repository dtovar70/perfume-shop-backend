import type { RateCurrency } from '../rate-currency.js'

/** A rate as a provider reports it, before it is stored. */
export interface FetchedRate {
    /** Bolívares per unit of the currency (US dollar, euro or USDT). */
    rate: number
    /** BCV "fecha valor": the day the rate applies to, "YYYY-MM-DD" (Caracas). */
    effectiveDate: string
}

export type RateSource = 'bcv' | 'dolarapi' | 'binance' | 'manual'
export type AutomaticRateSource = Exclude<RateSource, 'manual'>

/** Per requested currency: the rate, or why that one could not be read. */
export type ProviderRates = Partial<Record<RateCurrency, FetchedRate | Error>>

/**
 * One place rates can be read from. For each currency, the providers that offer it are tried in
 * order until one answers.
 */
export interface ExchangeRateProvider {
    readonly source: AutomaticRateSource
    /** The currencies this source publishes. */
    readonly currencies: readonly RateCurrency[]
    /**
     * Reads the requested currencies (a subset of `currencies`). Throws when nothing could be
     * read at all (site down); a single currency that failed maps to its error.
     */
    fetchRates(currencies: readonly RateCurrency[]): Promise<ProviderRates>
}

export const EXCHANGE_RATE_PROVIDERS = Symbol('EXCHANGE_RATE_PROVIDERS')

/** Human name of each source, for the admin. */
export const RATE_SOURCE_LABELS: Record<RateSource, string> = {
    bcv: 'BCV (bcv.org.ve)',
    dolarapi: 'DolarApi (dólar oficial BCV)',
    binance: 'Binance P2P',
    manual: 'Manual',
}

/** The source's name for a rate of this currency ("DolarApi (euro oficial BCV)"). */
export function rateSourceLabel(source: RateSource, currency: RateCurrency): string {
    if (source === 'dolarapi' && currency === 'EUR') return 'DolarApi (euro oficial BCV)'
    return RATE_SOURCE_LABELS[source] ?? source
}

/** Sanity bounds: anything outside is a parsing error, not a rate. */
export const MIN_PLAUSIBLE_RATE = 0.0001
export const MAX_PLAUSIBLE_RATE = 100_000_000

/** Rounds to the 4 decimals the rates are stored with. */
export function roundRate(rate: number): number {
    return Math.round(rate * 10_000) / 10_000
}

export function assertPlausibleRate(rate: number, source: string): number {
    if (!Number.isFinite(rate) || rate < MIN_PLAUSIBLE_RATE || rate > MAX_PLAUSIBLE_RATE) {
        throw new Error(`${source}: implausible rate ${String(rate)}`)
    }
    return roundRate(rate)
}

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}

/** Runs `read` per currency, mapping a failure to that currency's error. */
export async function readEach(
    currencies: readonly RateCurrency[],
    read: (currency: RateCurrency) => FetchedRate | Promise<FetchedRate>,
): Promise<ProviderRates> {
    const settled = await Promise.allSettled(
        currencies.map(async (currency) => await read(currency)),
    )
    return Object.fromEntries(
        currencies.map((currency, index) => {
            const result = settled[index]!
            return [currency, result.status === 'fulfilled' ? result.value : toError(result.reason)]
        }),
    ) as ProviderRates
}
