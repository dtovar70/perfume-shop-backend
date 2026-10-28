/**
 * What a rate converts from. Prices are always in US dollars; the business picks which rate
 * turns them into bolívares (`Bs = USD price x rate`), so an order in "EUR" still has its prices
 * in dollars, only multiplied by the BCV euro rate.
 */
export const RATE_CURRENCIES = ['USD', 'EUR', 'USDT'] as const
export type RateCurrency = (typeof RATE_CURRENCIES)[number]

/** Used until an admin picks another one (and by every order placed before the choice existed). */
export const DEFAULT_RATE_CURRENCY: RateCurrency = 'USD'

export function isRateCurrency(value: unknown): value is RateCurrency {
    return (RATE_CURRENCIES as readonly unknown[]).includes(value)
}

/** The choice as the admin sees it. */
export const RATE_CURRENCY_LABELS: Record<RateCurrency, string> = {
    USD: 'Dólar BCV',
    EUR: 'Euro BCV',
    USDT: 'USDT Binance',
}

/** The rate's name in order texts: "Tasa BCV del 24/09/2026". */
export const RATE_NAMES: Record<RateCurrency, string> = {
    USD: 'Tasa BCV',
    EUR: 'Tasa BCV (€)',
    USDT: 'Tasa USDT Binance',
}

/** Written after a rate: "854,4637 Bs/$". */
export const RATE_UNITS: Record<RateCurrency, string> = {
    USD: 'Bs/$',
    EUR: 'Bs/€',
    USDT: 'Bs/USDT',
}
