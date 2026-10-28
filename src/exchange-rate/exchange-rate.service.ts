import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException,
    type OnApplicationBootstrap,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { SchedulerRegistry } from '@nestjs/schedule'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'
import { CacheInvalidator } from '../cache/cache-invalidator.js'
import { CACHE_KEYS } from '../cache/cache-keys.js'
import { MemoryCache } from '../cache/memory-cache.js'
import type { AuthUser } from '../common/types/auth-user.js'
import { addDays, caracasDay, isDateOnly, startOfCaracasDay } from '../common/utils/caracas-date.js'
import type { Env } from '../config/env.schema.js'
import { scheduledJobsEnabled } from '../config/jobs.js'
import { runExclusive } from '../database/advisory-lock.js'
import { newId } from '../database/id.js'
import { AppSetting } from '../settings/entities/app-setting.entity.js'
import { ExchangeRate } from './entities/exchange-rate.entity.js'
import {
    EXCHANGE_RATE_EVENTS,
    type RateSnapshot,
    type RateSyncFailingEvent,
    type RateSyncRecoveredEvent,
} from './exchange-rate.events.js'
import {
    EXCHANGE_RATE_PROVIDERS,
    rateSourceLabel,
    roundRate,
    toError,
    type AutomaticRateSource,
    type ExchangeRateProvider,
    type FetchedRate,
    type ProviderRates,
    type RateSource,
} from './providers/rate-provider.js'
import {
    DEFAULT_RATE_CURRENCY,
    isRateCurrency,
    RATE_CURRENCIES,
    RATE_CURRENCY_LABELS,
    type RateCurrency,
} from './rate-currency.js'

const HOUR_MS = 3_600_000
const HISTORY_LIMIT = 5
/** A manual rate may be dated ahead (the BCV publishes the next business day's rate). */
const MANUAL_MAX_DAYS_AHEAD = 7
/**
 * Extra life of a USDT rate past its max age. Its fecha valor is the day it was read, so it
 * would expire at midnight and pause checkout until the next Binance run; with this margin
 * yesterday's price stays usable overnight (or through a Binance outage) until a new one lands.
 */
export const USDT_GRACE_HOURS = 6
/** The `app_settings` key of the rate checkout uses. */
const ACTIVE_CURRENCY_KEY = 'exchange_rate_currency'
/**
 * Failed BCV syncs in a row before the admins are alerted (once) on Telegram. With the default
 * 120-minute interval, 3 runs are about 6 hours without a new rate.
 */
export const SYNC_FAILURE_ALERT_THRESHOLD = 3
/** Same for USDT: with the default 10-minute interval, 6 runs are about an hour. */
export const USDT_SYNC_FAILURE_ALERT_THRESHOLD = 6

/**
 * The rates are fetched in two independent runs: the BCV ones (dollar and euro, from the BCV
 * website or its mirror) a few times a day, and the Binance P2P price of USDT, which moves
 * during the day, every few minutes. A USDT failure never falls back to a BCV rate.
 */
export const SYNC_GROUPS = {
    bcv: {
        currencies: ['USD', 'EUR'],
        alertAfterFailures: SYNC_FAILURE_ALERT_THRESHOLD,
        intervalSetting: 'EXCHANGE_RATE_SYNC_INTERVAL_MINUTES',
        intervalName: 'exchange-rate-sync',
        lockName: 'exchange-rate-sync',
    },
    binance: {
        currencies: ['USDT'],
        alertAfterFailures: USDT_SYNC_FAILURE_ALERT_THRESHOLD,
        intervalSetting: 'EXCHANGE_RATE_USDT_SYNC_INTERVAL_MINUTES',
        intervalName: 'exchange-rate-sync-usdt',
        lockName: 'exchange-rate-sync-usdt',
    },
} as const satisfies Record<
    string,
    {
        currencies: readonly RateCurrency[]
        alertAfterFailures: number
        intervalSetting: keyof Env
        intervalName: string
        lockName: string
    }
>
export type SyncGroup = keyof typeof SYNC_GROUPS
const SYNC_GROUP_NAMES = Object.keys(SYNC_GROUPS) as SyncGroup[]

export const EXCHANGE_RATE_UNAVAILABLE = 'EXCHANGE_RATE_UNAVAILABLE'
export const EXCHANGE_RATE_UNAVAILABLE_MESSAGE =
    'No pudimos obtener la tasa del BCV. Intenta más tarde o contáctanos por WhatsApp.'
const EXCHANGE_RATE_UNAVAILABLE_MESSAGES: Record<RateCurrency, string> = {
    USD: EXCHANGE_RATE_UNAVAILABLE_MESSAGE,
    EUR: EXCHANGE_RATE_UNAVAILABLE_MESSAGE,
    USDT: 'No pudimos obtener la tasa de cambio. Intenta más tarde o contáctanos por WhatsApp.',
}

/** A stored rate as the API returns it. */
export interface ExchangeRateDto {
    id: string
    currency: RateCurrency
    rate: number
    source: RateSource
    sourceLabel: string
    effectiveDate: string
    fetchedAt: string
    isManual: boolean
    createdBy: { id: string; name: string } | null
}

/** The rate checkout would use right now, with its freshness. */
export interface CurrentRateDto extends ExchangeRateDto {
    /**
     * After this instant the rate is too old for checkout: the start of its fecha valor plus the
     * max age (by default, the end of the fecha valor day).
     */
    usableUntil: string
    isStale: boolean
}

/** `GET /exchange-rate/current`: the active currency's rate. */
export type PublicCurrentRateDto =
    | ({ available: true } & Omit<CurrentRateDto, 'createdBy' | 'id'>)
    | {
          available: false
          currency: RateCurrency
          reason: 'missing' | 'stale'
          message: string
      }

export interface SyncAttempt {
    source: AutomaticRateSource
    currency: RateCurrency
    ok: boolean
    rate?: number
    effectiveDate?: string
    error?: string
}

export interface CurrencySyncResult {
    /** Stored = a new row was added; unchanged = same as its last automatic rate. */
    outcome: 'stored' | 'unchanged' | 'failed'
    /** The provider that answered (absent when none did). */
    source?: AutomaticRateSource
    rate?: number
    effectiveDate?: string
}

export interface SyncResult {
    at: string
    /** Stored = some currency got a new row; failed = no currency could be read. */
    outcome: 'stored' | 'unchanged' | 'failed'
    currencies: Partial<Record<RateCurrency, CurrencySyncResult>>
    attempts: SyncAttempt[]
}

/** One currency in the admin: its newest rate and the last few. */
export interface AdminCurrencyRatesDto {
    currency: RateCurrency
    label: string
    current: CurrentRateDto | null
    history: ExchangeRateDto[]
}

export interface AdminSyncGroupDto {
    group: SyncGroup
    currencies: RateCurrency[]
    intervalMinutes: number
    lastSync: SyncResult | null
}

export interface AdminExchangeRateDto {
    /** The rate checkout converts with. */
    activeCurrency: RateCurrency
    /** Null while the default was never changed. */
    activeCurrencyUpdatedAt: string | null
    activeCurrencyUpdatedBy: { id: string; name: string } | null
    /** The active currency's newest rate. */
    current: CurrentRateDto | null
    /** Every currency, in RATE_CURRENCIES order. */
    rates: AdminCurrencyRatesDto[]
    syncs: AdminSyncGroupDto[]
    maxAgeHours: number
}

function toDto(row: ExchangeRate): ExchangeRateDto {
    const currency = row.currency ?? DEFAULT_RATE_CURRENCY
    return {
        id: row.id,
        currency,
        rate: row.rate,
        source: row.source,
        sourceLabel: rateSourceLabel(row.source, currency),
        effectiveDate: row.effectiveDate,
        fetchedAt: row.fetchedAt.toISOString(),
        isManual: row.isManual,
        createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    }
}

/** A stored setting value as a currency (the default when missing or unknown). */
function parseCurrency(value: unknown): RateCurrency {
    return isRateCurrency(value) ? value : DEFAULT_RATE_CURRENCY
}

function overallOutcome(
    currencies: Partial<Record<RateCurrency, CurrencySyncResult>>,
): SyncResult['outcome'] {
    const outcomes = Object.values(currencies).map((result) => result.outcome)
    if (outcomes.includes('stored')) return 'stored'
    return outcomes.every((outcome) => outcome === 'failed') ? 'failed' : 'unchanged'
}

/**
 * Last instant a rate with this fecha valor may be used: its day's start + max age (with the
 * default 24 h, the end of the fecha valor day in Caracas).
 */
export function rateUsableUntil(effectiveDate: string, maxAgeHours: number): Date {
    return new Date(startOfCaracasDay(effectiveDate).getTime() + maxAgeHours * HOUR_MS)
}

export function isRateStale(effectiveDate: string, maxAgeHours: number, now = new Date()): boolean {
    return now.getTime() > rateUsableUntil(effectiveDate, maxAgeHours).getTime()
}

/**
 * The bolívar rates (BCV dollar, BCV euro, USDT on Binance P2P) and which one the business
 * converts with. For each currency the providers that offer it are tried in order; a new row is
 * stored only when its rate or fecha valor changed, so a manual rate stays in force until its
 * source publishes a different one.
 */
@Injectable()
export class ExchangeRateService implements OnApplicationBootstrap {
    private readonly logger = new Logger(ExchangeRateService.name)
    private readonly maxAgeHours: number
    private readonly intervals: Record<SyncGroup, number>
    private readonly running = new Map<SyncGroup, Promise<SyncResult>>()
    private readonly lastSync: Record<SyncGroup, SyncResult | null> = { bcv: null, binance: null }
    /**
     * Per currency: failed syncs since the last success, and whether the "sync failing" alert
     * went out with no success after it (in memory: a restart starts over).
     */
    private readonly health = Object.fromEntries(
        RATE_CURRENCIES.map((currency) => [currency, { failures: 0, alerted: false }]),
    ) as Record<RateCurrency, { failures: number; alerted: boolean }>

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(ExchangeRate) private readonly rates: Repository<ExchangeRate>,
        @InjectRepository(AppSetting) private readonly settings: Repository<AppSetting>,
        @Inject(EXCHANGE_RATE_PROVIDERS) private readonly providers: ExchangeRateProvider[],
        private readonly config: ConfigService<Env, true>,
        private readonly scheduler: SchedulerRegistry,
        private readonly events: EventEmitter2,
        private readonly cache: MemoryCache,
        private readonly invalidator: CacheInvalidator,
    ) {
        this.maxAgeHours = config.get('EXCHANGE_RATE_MAX_AGE_HOURS', { infer: true })
        this.intervals = {
            bcv: config.get(SYNC_GROUPS.bcv.intervalSetting, { infer: true }),
            binance: config.get(SYNC_GROUPS.binance.intervalSetting, { infer: true }),
        }
    }

    onApplicationBootstrap(): void {
        if (!scheduledJobsEnabled(this.config)) return
        for (const group of SYNC_GROUP_NAMES) {
            // Not awaited: startup must not wait for (or fail because of) a slow website.
            void this.scheduledSync(group)
            const interval = setInterval(
                () => void this.scheduledSync(group),
                this.intervals[group] * 60_000,
            )
            this.scheduler.addInterval(SYNC_GROUPS[group].intervalName, interval)
        }
    }

    /**
     * The cron's run: skipped while another API instance syncs (advisory lock), so a second
     * instance never fetches and stores the same rate twice. Never throws.
     */
    private async scheduledSync(group: SyncGroup): Promise<void> {
        try {
            await runExclusive(this.dataSource, SYNC_GROUPS[group].lockName, async () => {
                await this.sync(group)
            })
        } catch (error) {
            this.logger.error(`Scheduled ${group} rate sync failed: ${toError(error).message}`)
        }
    }

    /** The currency checkout converts with. Cached; changing it invalidates the cache. */
    activeCurrency(): Promise<RateCurrency> {
        return this.cache.getOrSet(CACHE_KEYS.exchangeRateCurrency(), async () => {
            const row = await this.settings.findOne({ where: { key: ACTIVE_CURRENCY_KEY } })
            return parseCurrency(row?.value)
        })
    }

    /**
     * Newest stored rate of a currency (the active one by default), fresh or not. Cached (the
     * storefront and every checkout ask for it); freshness is still computed on each read, so a
     * cached row turns stale on time.
     */
    async latest(currency?: RateCurrency): Promise<ExchangeRate | null> {
        const wanted = currency ?? (await this.activeCurrency())
        return this.cache.getOrSet(CACHE_KEYS.latestExchangeRate(wanted), () =>
            this.rates.findOne({
                where: { currency: wanted },
                order: { fetchedAt: 'DESC', id: 'DESC' },
                relations: { createdBy: true },
            }),
        )
    }

    async current(currency?: RateCurrency): Promise<CurrentRateDto | null> {
        const row = await this.latest(currency)
        return row ? this.withFreshness(row) : null
    }

    async publicCurrent(): Promise<PublicCurrentRateDto> {
        const currency = await this.activeCurrency()
        const current = await this.current(currency)
        if (!current || current.isStale) {
            return {
                available: false,
                currency,
                reason: current ? 'stale' : 'missing',
                message: EXCHANGE_RATE_UNAVAILABLE_MESSAGES[currency],
            }
        }
        const { id: _id, createdBy: _createdBy, ...rest } = current
        return { available: true, ...rest }
    }

    /**
     * The active currency's rate for a new order; 503 in Spanish when there is none or it is
     * too old (checkout never falls back to another currency).
     */
    async requireUsableRate(): Promise<ExchangeRate> {
        const currency = await this.activeCurrency()
        const row = await this.latest(currency)
        if (!row || isRateStale(row.effectiveDate, this.maxAgeHoursFor(currency))) {
            throw new ServiceUnavailableException({
                statusCode: 503,
                error: 'Service Unavailable',
                code: EXCHANGE_RATE_UNAVAILABLE,
                message: EXCHANGE_RATE_UNAVAILABLE_MESSAGES[currency],
            })
        }
        return row
    }

    async adminView(): Promise<AdminExchangeRateDto> {
        const [setting, ...histories] = await Promise.all([
            this.settings.findOne({
                where: { key: ACTIVE_CURRENCY_KEY },
                relations: { updatedBy: true },
            }),
            ...RATE_CURRENCIES.map((currency) =>
                this.rates.find({
                    where: { currency },
                    order: { fetchedAt: 'DESC', id: 'DESC' },
                    take: HISTORY_LIMIT,
                    relations: { createdBy: true },
                }),
            ),
        ])
        const activeCurrency = parseCurrency(setting?.value)
        const rates = RATE_CURRENCIES.map((currency, index): AdminCurrencyRatesDto => {
            const history = histories[index] ?? []
            const newest = history[0]
            return {
                currency,
                label: RATE_CURRENCY_LABELS[currency],
                current: newest ? this.withFreshness(newest) : null,
                history: history.map(toDto),
            }
        })
        const updatedBy = setting?.updatedBy ?? null
        return {
            activeCurrency,
            activeCurrencyUpdatedAt: setting ? setting.updatedAt.toISOString() : null,
            activeCurrencyUpdatedBy: updatedBy ? { id: updatedBy.id, name: updatedBy.name } : null,
            current: rates.find((entry) => entry.currency === activeCurrency)?.current ?? null,
            rates,
            syncs: SYNC_GROUP_NAMES.map((group) => ({
                group,
                currencies: [...SYNC_GROUPS[group].currencies],
                intervalMinutes: this.intervals[group],
                lastSync: this.lastSync[group],
            })),
            maxAgeHours: this.maxAgeHours,
        }
    }

    /**
     * Asks the providers for the rates and stores the ones that changed: one group, or all of
     * them ("Actualizar ahora"). Never throws.
     */
    async sync(group?: SyncGroup): Promise<SyncResult> {
        if (group) return this.syncGroup(group)
        const results = await Promise.all(SYNC_GROUP_NAMES.map((name) => this.syncGroup(name)))
        const currencies = Object.assign(
            {},
            ...results.map((result) => result.currencies),
        ) as SyncResult['currencies']
        return {
            at: new Date().toISOString(),
            outcome: overallOutcome(currencies),
            currencies,
            attempts: results.flatMap((result) => result.attempts),
        }
    }

    private syncGroup(group: SyncGroup): Promise<SyncResult> {
        // Concurrent callers (cron + "Actualizar ahora") share one run.
        let run = this.running.get(group)
        if (!run) {
            run = this.runSync(group).finally(() => this.running.delete(group))
            this.running.set(group, run)
        }
        return run
    }

    async setManual(
        currency: RateCurrency,
        rate: number,
        effectiveDate: string | undefined,
        user: AuthUser,
    ) {
        const today = caracasDay()
        const day = effectiveDate ?? today
        if (!isDateOnly(day)) {
            throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                message: 'Los datos enviados no son válidos. Revisa los campos marcados.',
                details: [{ field: 'effectiveDate', errors: ['La fecha valor no es válida.'] }],
            })
        }
        if (day > addDays(today, MANUAL_MAX_DAYS_AHEAD)) {
            throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                message: 'Los datos enviados no son válidos. Revisa los campos marcados.',
                details: [
                    {
                        field: 'effectiveDate',
                        errors: [
                            `La fecha valor no puede estar a más de ${MANUAL_MAX_DAYS_AHEAD} días en el futuro.`,
                        ],
                    },
                ],
            })
        }
        await this.rates.insert({
            id: newId(),
            currency,
            rate: roundRate(rate),
            source: 'manual',
            effectiveDate: day,
            fetchedAt: new Date(),
            isManual: true,
            createdById: user.id,
        })
        this.invalidator.invalidate('exchange-rate')
        this.logger.log(`Manual ${currency} rate ${rate} (${day}) set by ${user.email}`)
        return this.adminView()
    }

    /**
     * Switches the rate checkout converts with. Orders already placed keep their snapshot; new
     * ones (and the storefront, through the `exchange-rate` push) use the new currency at once.
     */
    async setActiveCurrency(currency: RateCurrency, user: AuthUser): Promise<AdminExchangeRateDto> {
        const previous = await this.activeCurrency()
        await this.settings.upsert(
            {
                key: ACTIVE_CURRENCY_KEY,
                value: currency,
                updatedAt: new Date(),
                updatedById: user.id,
            },
            ['key'],
        )
        this.invalidator.invalidate('exchange-rate')
        this.logger.log(`Active rate currency changed ${previous} -> ${currency} by ${user.email}`)
        return this.adminView()
    }

    private withFreshness(row: ExchangeRate): CurrentRateDto {
        const maxAgeHours = this.maxAgeHoursFor(row.currency)
        return {
            ...toDto(row),
            usableUntil: rateUsableUntil(row.effectiveDate, maxAgeHours).toISOString(),
            isStale: isRateStale(row.effectiveDate, maxAgeHours),
        }
    }

    private maxAgeHoursFor(currency: RateCurrency): number {
        return currency === 'USDT' ? this.maxAgeHours + USDT_GRACE_HOURS : this.maxAgeHours
    }

    private async runSync(group: SyncGroup): Promise<SyncResult> {
        const attempts: SyncAttempt[] = []
        const currencies: SyncResult['currencies'] = {}
        let pending: RateCurrency[] = [...SYNC_GROUPS[group].currencies]

        for (const provider of this.providers) {
            const wanted = pending.filter((currency) => provider.currencies.includes(currency))
            if (!wanted.length) continue
            let fetched: ProviderRates
            try {
                fetched = await provider.fetchRates(wanted)
            } catch (error) {
                const failure = toError(error)
                fetched = Object.fromEntries(wanted.map((currency) => [currency, failure]))
            }
            for (const currency of wanted) {
                let result: FetchedRate | Error =
                    fetched[currency] ?? new Error(`${provider.source}: no ${currency} rate`)
                if (!(result instanceof Error)) {
                    try {
                        const stored = await this.storeIfChanged(currency, provider.source, result)
                        attempts.push({ source: provider.source, currency, ok: true, ...result })
                        currencies[currency] = {
                            outcome: stored ? 'stored' : 'unchanged',
                            source: provider.source,
                            ...result,
                        }
                        continue
                    } catch (error) {
                        result = toError(error)
                    }
                }
                attempts.push({
                    source: provider.source,
                    currency,
                    ok: false,
                    error: result.message,
                })
                this.logger.warn(
                    `Rate provider ${provider.source} failed for ${currency}: ${result.message}`,
                )
            }
            pending = pending.filter((currency) => !currencies[currency])
            if (!pending.length) break
        }

        for (const currency of pending) {
            currencies[currency] = { outcome: 'failed' }
            this.logger.error(`No exchange-rate provider answered for ${currency}`)
        }
        if (Object.values(currencies).some((result) => result.outcome === 'stored')) {
            this.invalidator.invalidate('exchange-rate')
        }
        const result: SyncResult = {
            at: new Date().toISOString(),
            outcome: overallOutcome(currencies),
            currencies,
            attempts,
        }
        this.lastSync[group] = result
        await this.trackHealth(group, result)
        return result
    }

    /** Adds a row when the rate or its fecha valor differs from the last automatic one. */
    private async storeIfChanged(
        currency: RateCurrency,
        source: AutomaticRateSource,
        fetched: FetchedRate,
    ): Promise<boolean> {
        const lastAutomatic = await this.rates.findOne({
            where: { currency, isManual: false },
            order: { fetchedAt: 'DESC', id: 'DESC' },
        })
        const changed =
            !lastAutomatic ||
            lastAutomatic.rate !== fetched.rate ||
            lastAutomatic.effectiveDate !== fetched.effectiveDate
        if (!changed) return false
        await this.rates.insert({
            id: newId(),
            currency,
            rate: fetched.rate,
            source,
            effectiveDate: fetched.effectiveDate,
            fetchedAt: new Date(),
            isManual: false,
            createdById: null,
        })
        this.logger.log(
            `Stored ${currency} rate ${fetched.rate} (${fetched.effectiveDate}) from ${source}`,
        )
        return true
    }

    /**
     * Counts failed runs in a row per currency. Once the active currency (the one checkout uses)
     * reaches its group's threshold the admins are alerted once, and once more when a later run
     * of it succeeds. Never throws.
     */
    private async trackHealth(group: SyncGroup, result: SyncResult): Promise<void> {
        try {
            for (const currency of SYNC_GROUPS[group].currencies) {
                const health = this.health[currency]
                const outcome = result.currencies[currency]?.outcome ?? 'failed'
                if (outcome === 'failed') {
                    health.failures++
                    if (
                        health.alerted ||
                        health.failures < SYNC_GROUPS[group].alertAfterFailures ||
                        currency !== (await this.activeCurrency())
                    ) {
                        continue
                    }
                    health.alerted = true
                    const event: RateSyncFailingEvent = {
                        currency,
                        consecutiveFailures: health.failures,
                        errors: result.attempts
                            .filter((attempt) => attempt.currency === currency)
                            .map((attempt) => ({
                                source: attempt.source,
                                error: attempt.error ?? 'error',
                            })),
                        current: await this.snapshot(currency),
                        at: result.at,
                    }
                    this.logger.warn(
                        `${currency} rate sync failed ${health.failures} times in a row; alerting admins`,
                    )
                    this.events.emit(EXCHANGE_RATE_EVENTS.syncFailing, event)
                    continue
                }
                const failedRuns = health.failures
                const alerted = health.alerted
                health.failures = 0
                health.alerted = false
                if (!alerted) continue
                const event: RateSyncRecoveredEvent = {
                    currency,
                    outcome,
                    failedRuns,
                    current: await this.snapshot(currency),
                    at: result.at,
                }
                this.logger.log(`${currency} rate sync recovered after ${failedRuns} failed runs`)
                this.events.emit(EXCHANGE_RATE_EVENTS.syncRecovered, event)
            }
        } catch (error) {
            this.logger.error(`Rate sync alert failed: ${toError(error).message}`)
        }
    }

    private async snapshot(currency: RateCurrency): Promise<RateSnapshot | null> {
        const current = await this.current(currency)
        if (!current) return null
        return {
            currency,
            rate: current.rate,
            source: current.source,
            effectiveDate: current.effectiveDate,
            usableUntil: current.usableUntil,
            isStale: current.isStale,
        }
    }
}
