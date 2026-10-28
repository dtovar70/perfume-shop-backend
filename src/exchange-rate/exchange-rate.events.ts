import type { AutomaticRateSource, RateSource } from './providers/rate-provider.js'
import type { RateCurrency } from './rate-currency.js'

/**
 * Rate-sync health events. Listeners (the Telegram bot) subscribe with `@OnEvent(...)`, so the
 * exchange-rate module never depends on who is told.
 */
export const EXCHANGE_RATE_EVENTS = {
    /**
     * Emitted once when the automatic sync of the active currency (the one checkout uses) has
     * failed several times in a row.
     */
    syncFailing: 'exchange_rate.sync_failing',
    /** Emitted once when a sync of that currency succeeds again after `syncFailing`. */
    syncRecovered: 'exchange_rate.sync_recovered',
} as const

/** A stored rate of one currency, as the events carry it. */
export interface RateSnapshot {
    currency: RateCurrency
    rate: number
    source: RateSource
    effectiveDate: string
    /** ISO instant after which orders pause unless a newer rate arrives. */
    usableUntil: string
    isStale: boolean
}

export interface RateSyncFailingEvent {
    currency: RateCurrency
    consecutiveFailures: number
    /** One entry per provider tried for the currency in the last run. */
    errors: { source: AutomaticRateSource; error: string }[]
    /** Null when no rate of the currency was ever stored. */
    current: RateSnapshot | null
    at: string
}

export interface RateSyncRecoveredEvent {
    currency: RateCurrency
    outcome: 'stored' | 'unchanged'
    /** Failed runs before this success. */
    failedRuns: number
    current: RateSnapshot | null
    at: string
}
