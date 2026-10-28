import { CacheInvalidator } from '../cache/cache-invalidator.js'
import { MemoryCache } from '../cache/memory-cache.js'
import type { ConfigService } from '@nestjs/config'
import type { EventEmitter2 } from '@nestjs/event-emitter'
import type { SchedulerRegistry } from '@nestjs/schedule'
import type { DataSource, Repository } from 'typeorm'
import type { AuthUser } from '../common/types/auth-user.js'
import { caracasDay } from '../common/utils/caracas-date.js'
import type { Env } from '../config/env.schema.js'
import { RealtimeService } from '../realtime/realtime.service.js'
import type { AppSetting } from '../settings/entities/app-setting.entity.js'
import type { ExchangeRate } from './entities/exchange-rate.entity.js'
import { EXCHANGE_RATE_EVENTS } from './exchange-rate.events.js'
import {
    ExchangeRateService,
    isRateStale,
    rateUsableUntil,
    SYNC_FAILURE_ALERT_THRESHOLD,
} from './exchange-rate.service.js'
import type {
    AutomaticRateSource,
    ExchangeRateProvider,
    FetchedRate,
} from './providers/rate-provider.js'
import type { RateCurrency } from './rate-currency.js'

describe('rate freshness', () => {
    it('measures the age from the start of the fecha valor (Caracas)', () => {
        expect(rateUsableUntil('2026-09-24', 24).toISOString()).toBe('2026-09-25T04:00:00.000Z')
    })

    it('is usable up to the end of its fecha valor day and stale after it', () => {
        expect(isRateStale('2026-09-24', 24, new Date('2026-09-25T03:59:59Z'))).toBe(false)
        expect(isRateStale('2026-09-24', 24, new Date('2026-09-25T04:00:01Z'))).toBe(true)
    })

    it('treats a rate published for the next business day as fresh', () => {
        // Friday afternoon the BCV publishes Monday's rate: it covers the weekend.
        expect(isRateStale('2026-09-28', 24, new Date('2026-09-25T20:00:00Z'))).toBe(false)
        expect(isRateStale('2026-09-28', 24, new Date('2026-09-27T20:00:00Z'))).toBe(false)
    })
})

type Row = Record<string, unknown>
const ADMIN = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' } as AuthUser

/** `exchange_rates` in memory: rows newest last, like the real ordering by fetched_at. */
function rateRepository(rows: Row[]) {
    const matching = (where: Row = {}) =>
        rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
    return {
        rows,
        findOne: vi.fn(({ where }: { where?: Row }) =>
            Promise.resolve(matching(where).at(-1) ?? null),
        ),
        find: vi.fn(({ where, take }: { where?: Row; take?: number }) =>
            Promise.resolve(matching(where).reverse().slice(0, take)),
        ),
        insert: vi.fn((row: Row) => {
            rows.push({ createdBy: null, ...row })
            return Promise.resolve({})
        }),
    }
}

function settingsRepository() {
    const rows = new Map<string, Row>()
    return {
        rows,
        findOne: vi.fn(({ where }: { where: { key: string } }) =>
            Promise.resolve(rows.get(where.key) ?? null),
        ),
        upsert: vi.fn((row: Row) => {
            rows.set(row.key as string, { updatedBy: null, ...row })
            return Promise.resolve({})
        }),
    }
}

/** A provider whose answers the test changes; `null` makes a currency fail. */
function fakeProvider(source: AutomaticRateSource, currencies: RateCurrency[]) {
    const answers: Partial<Record<RateCurrency, FetchedRate | null>> = {}
    let down = false
    const provider: ExchangeRateProvider = {
        source,
        currencies,
        fetchRates: vi.fn((wanted: readonly RateCurrency[]) => {
            if (down) return Promise.reject(new Error(`${source} down`))
            return Promise.resolve(
                Object.fromEntries(
                    wanted.map((currency) => [
                        currency,
                        answers[currency] ?? new Error(`${source}: no ${currency}`),
                    ]),
                ),
            )
        }),
    }
    return {
        provider,
        answer: (currency: RateCurrency, value: FetchedRate | null) => {
            answers[currency] = value
        },
        setDown: (value: boolean) => {
            down = value
        },
    }
}

function setup(seed: Row[] = []) {
    const rates = rateRepository(seed)
    const settings = settingsRepository()
    const bcv = fakeProvider('bcv', ['USD', 'EUR'])
    const dolarapi = fakeProvider('dolarapi', ['USD', 'EUR'])
    const binance = fakeProvider('binance', ['USDT'])
    const config = {
        get: (key: keyof Env) =>
            ({
                EXCHANGE_RATE_MAX_AGE_HOURS: 24,
                EXCHANGE_RATE_SYNC_INTERVAL_MINUTES: 120,
                EXCHANGE_RATE_USDT_SYNC_INTERVAL_MINUTES: 10,
            })[key as string],
    } as unknown as ConfigService<Env, true>
    const emit = vi.fn()
    const cache = new MemoryCache()
    const realtime = new RealtimeService()
    const publish = vi.spyOn(realtime, 'publish')
    const service = new ExchangeRateService(
        {} as DataSource,
        rates as unknown as Repository<ExchangeRate>,
        settings as unknown as Repository<AppSetting>,
        [bcv.provider, dolarapi.provider, binance.provider],
        config,
        {} as SchedulerRegistry,
        { emit } as unknown as EventEmitter2,
        cache,
        new CacheInvalidator(cache, realtime),
    )
    return { service, rates, settings, bcv, dolarapi, binance, emit, publish }
}

const today = caracasDay()
const usdRow = (rate: number, extra: Row = {}): Row => ({
    id: `usd-${rate}`,
    currency: 'USD',
    rate,
    source: 'bcv',
    effectiveDate: today,
    fetchedAt: new Date(),
    isManual: false,
    createdBy: null,
    ...extra,
})

describe('ExchangeRateService per-currency sync', () => {
    it('stores the dollar and the euro independently, each only when it changed', async () => {
        const { service, rates, bcv, publish } = setup()
        bcv.answer('USD', { rate: 854.4637, effectiveDate: today })
        bcv.answer('EUR', { rate: 974.063, effectiveDate: today })

        const first = await service.sync('bcv')
        expect(first.outcome).toBe('stored')
        expect(first.currencies).toMatchObject({
            USD: { outcome: 'stored', source: 'bcv', rate: 854.4637 },
            EUR: { outcome: 'stored', source: 'bcv', rate: 974.063 },
        })
        expect(rates.rows.map((row) => [row.currency, row.rate])).toEqual([
            ['USD', 854.4637],
            ['EUR', 974.063],
        ])
        expect(publish).toHaveBeenCalledWith({ type: 'exchange-rate' })

        // Only the euro moved: one new euro row, the dollar is unchanged.
        bcv.answer('EUR', { rate: 975, effectiveDate: today })
        publish.mockClear()
        const second = await service.sync('bcv')
        expect(second.currencies).toMatchObject({
            USD: { outcome: 'unchanged' },
            EUR: { outcome: 'stored', rate: 975 },
        })
        expect(rates.rows).toHaveLength(3)
        expect(publish).toHaveBeenCalledTimes(1)

        publish.mockClear()
        expect((await service.sync('bcv')).outcome).toBe('unchanged')
        expect(publish).not.toHaveBeenCalled()
    })

    it('asks the fallback only for the currency the BCV page did not give', async () => {
        const { service, bcv, dolarapi } = setup()
        bcv.answer('USD', { rate: 854.4637, effectiveDate: today })
        dolarapi.answer('EUR', { rate: 974.063, effectiveDate: today })

        const result = await service.sync('bcv')
        expect(dolarapi.provider.fetchRates).toHaveBeenCalledWith(['EUR'])
        expect(result.currencies).toMatchObject({
            USD: { outcome: 'stored', source: 'bcv' },
            EUR: { outcome: 'stored', source: 'dolarapi' },
        })
        expect(result.attempts).toEqual([
            expect.objectContaining({ source: 'bcv', currency: 'USD', ok: true }),
            expect.objectContaining({ source: 'bcv', currency: 'EUR', ok: false }),
            expect.objectContaining({ source: 'dolarapi', currency: 'EUR', ok: true }),
        ])
    })

    it('syncs USDT from Binance only, keeping the last price when Binance fails', async () => {
        const { service, rates, bcv, dolarapi, binance } = setup()
        binance.answer('USDT', { rate: 1007.7, effectiveDate: today })
        expect((await service.sync('binance')).currencies.USDT).toMatchObject({
            outcome: 'stored',
            source: 'binance',
        })
        expect(bcv.provider.fetchRates).not.toHaveBeenCalled()

        binance.setDown(true)
        const failed = await service.sync('binance')
        expect(failed.outcome).toBe('failed')
        expect(failed.attempts).toEqual([
            { source: 'binance', currency: 'USDT', ok: false, error: 'binance down' },
        ])
        // Never a BCV rate in place of USDT.
        expect(bcv.provider.fetchRates).not.toHaveBeenCalled()
        expect(dolarapi.provider.fetchRates).not.toHaveBeenCalled()
        expect(rates.rows).toHaveLength(1)
        expect(await service.latest('USDT')).toMatchObject({ rate: 1007.7 })
    })

    it('"Actualizar ahora" runs every group and reports each currency', async () => {
        const { service, bcv, binance } = setup()
        bcv.answer('USD', { rate: 854.4637, effectiveDate: today })
        bcv.answer('EUR', { rate: 974.063, effectiveDate: today })
        binance.answer('USDT', { rate: 1007.7, effectiveDate: today })
        const result = await service.sync()
        expect(Object.keys(result.currencies).sort()).toEqual(['EUR', 'USD', 'USDT'])
        expect(result.outcome).toBe('stored')
    })
})

describe('ExchangeRateService active currency', () => {
    const seed = () => [
        usdRow(854.4637),
        { ...usdRow(974.063), id: 'eur-1', currency: 'EUR' },
        { ...usdRow(1007.7), id: 'usdt-1', currency: 'USDT', source: 'binance' },
    ]

    it('defaults to the dollar, so nothing changes on deploy', async () => {
        const { service } = setup(seed())
        expect(await service.activeCurrency()).toBe('USD')
        expect(await service.requireUsableRate()).toMatchObject({ currency: 'USD' })
        expect(await service.publicCurrent()).toMatchObject({
            available: true,
            currency: 'USD',
            rate: 854.4637,
        })
    })

    it('checkout and the storefront use the chosen currency at once', async () => {
        const { service, settings, publish } = setup(seed())
        await service.requireUsableRate() // fills the cache with the dollar

        const view = await service.setActiveCurrency('EUR', ADMIN)
        expect(settings.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'exchange_rate_currency',
                value: 'EUR',
                updatedById: 'admin-1',
            }),
            ['key'],
        )
        expect(publish).toHaveBeenCalledWith({ type: 'exchange-rate' })
        expect(view).toMatchObject({
            activeCurrency: 'EUR',
            current: { currency: 'EUR', rate: 974.063, sourceLabel: 'BCV (bcv.org.ve)' },
        })
        expect(view.rates.map((entry) => [entry.currency, entry.current?.rate])).toEqual([
            ['USD', 854.4637],
            ['EUR', 974.063],
            ['USDT', 1007.7],
        ])
        expect(await service.requireUsableRate()).toMatchObject({ id: 'eur-1', rate: 974.063 })
        expect(await service.publicCurrent()).toMatchObject({ currency: 'EUR', rate: 974.063 })

        await service.setActiveCurrency('USDT', ADMIN)
        expect(await service.requireUsableRate()).toMatchObject({ id: 'usdt-1' })
        await service.setActiveCurrency('USD', ADMIN)
        expect(await service.requireUsableRate()).toMatchObject({ currency: 'USD' })
    })

    it('never falls back to another currency when the active one is missing', async () => {
        const { service } = setup([usdRow(854.4637)])
        await service.setActiveCurrency('EUR', ADMIN)
        await expect(service.requireUsableRate()).rejects.toMatchObject({
            response: { code: 'EXCHANGE_RATE_UNAVAILABLE' },
        })
        expect(await service.publicCurrent()).toMatchObject({
            available: false,
            currency: 'EUR',
            reason: 'missing',
        })
    })

    it('keeps a USDT rate usable overnight, past the midnight that expires the BCV rates', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            const yesterday = '2026-09-24'
            const { service } = setup([
                usdRow(854.4637, { effectiveDate: yesterday }),
                { ...usdRow(1007.7), id: 'usdt-1', currency: 'USDT', effectiveDate: yesterday },
            ])
            // 02:00 in Caracas: yesterday's dollar is stale, yesterday's USDT is not.
            vi.setSystemTime(new Date('2026-09-25T06:00:00Z'))
            await expect(service.requireUsableRate()).rejects.toMatchObject({
                response: { code: 'EXCHANGE_RATE_UNAVAILABLE' },
            })
            await service.setActiveCurrency('USDT', ADMIN)
            expect(await service.requireUsableRate()).toMatchObject({ id: 'usdt-1' })
            expect(await service.current('USDT')).toMatchObject({
                isStale: false,
                usableUntil: '2026-09-25T10:00:00.000Z',
            })

            // 06:00 in Caracas: without a fresh Binance price, USDT stops too.
            vi.setSystemTime(new Date('2026-09-25T10:00:01Z'))
            await expect(service.requireUsableRate()).rejects.toMatchObject({
                response: { code: 'EXCHANGE_RATE_UNAVAILABLE' },
            })
        } finally {
            vi.useRealTimers()
        }
    })

    it('stores a manual rate for the chosen currency only', async () => {
        const { service } = setup(seed())
        const view = await service.setManual('EUR', 980.5, undefined, ADMIN)
        expect(await service.latest('EUR')).toMatchObject({
            rate: 980.5,
            source: 'manual',
            isManual: true,
            createdById: 'admin-1',
        })
        expect(await service.latest('USD')).toMatchObject({ rate: 854.4637 })
        expect(view.rates.find((entry) => entry.currency === 'EUR')?.history).toHaveLength(2)
    })
})

describe('ExchangeRateService sync alerts', () => {
    function failingSetup() {
        const context = setup([usdRow(36.5, { effectiveDate: '2026-09-25' })])
        context.bcv.setDown(true)
        context.dolarapi.setDown(true)
        return {
            ...context,
            setFailing: (value: boolean) => {
                context.bcv.setDown(value)
                context.dolarapi.setDown(value)
                context.bcv.answer('USD', { rate: 36.5, effectiveDate: '2026-09-25' })
                context.bcv.answer('EUR', { rate: 40, effectiveDate: '2026-09-25' })
            },
        }
    }

    async function syncTimes(service: ExchangeRateService, times: number) {
        for (let i = 0; i < times; i++) await service.sync('bcv')
    }

    it('alerts once after the threshold of consecutive failures', async () => {
        const { service, emit } = failingSetup()
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        expect(emit).not.toHaveBeenCalled()

        await syncTimes(service, 1)
        expect(emit).toHaveBeenCalledTimes(1)
        expect(emit).toHaveBeenCalledWith(
            EXCHANGE_RATE_EVENTS.syncFailing,
            expect.objectContaining({
                currency: 'USD',
                consecutiveFailures: SYNC_FAILURE_ALERT_THRESHOLD,
                errors: [
                    { source: 'bcv', error: 'bcv down' },
                    { source: 'dolarapi', error: 'dolarapi down' },
                ],
                current: expect.objectContaining({
                    currency: 'USD',
                    rate: 36.5,
                    effectiveDate: '2026-09-25',
                    usableUntil: '2026-09-26T04:00:00.000Z',
                }),
            }),
        )

        await syncTimes(service, 5)
        expect(emit).toHaveBeenCalledTimes(1)
    })

    it('sends one recovery notice after an alert, then starts counting again', async () => {
        const { service, emit, setFailing } = failingSetup()
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD)
        setFailing(false)
        await syncTimes(service, 2)
        expect(emit).toHaveBeenCalledTimes(2)
        expect(emit).toHaveBeenLastCalledWith(
            EXCHANGE_RATE_EVENTS.syncRecovered,
            expect.objectContaining({
                currency: 'USD',
                outcome: 'unchanged',
                failedRuns: SYNC_FAILURE_ALERT_THRESHOLD,
            }),
        )

        setFailing(true)
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD)
        expect(emit).toHaveBeenCalledTimes(3)
        expect(emit).toHaveBeenLastCalledWith(EXCHANGE_RATE_EVENTS.syncFailing, expect.anything())
    })

    it('stays quiet when a success interrupts the failures before the threshold', async () => {
        const { service, emit, setFailing } = failingSetup()
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        setFailing(false)
        await syncTimes(service, 1)
        setFailing(true)
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        expect(emit).not.toHaveBeenCalled()
    })

    it('only alerts about the currency checkout uses', async () => {
        const { service, emit, bcv, dolarapi } = setup([usdRow(36.5)])
        // The dollar keeps answering; only the euro fails.
        bcv.answer('USD', { rate: 36.5, effectiveDate: today })
        dolarapi.answer('USD', { rate: 36.5, effectiveDate: today })
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD + 1)
        expect(emit).not.toHaveBeenCalled()

        await service.setActiveCurrency('EUR', ADMIN)
        await syncTimes(service, 1)
        expect(emit).toHaveBeenCalledWith(
            EXCHANGE_RATE_EVENTS.syncFailing,
            expect.objectContaining({ currency: 'EUR', current: null }),
        )
    })

    it('never lets a failing listener break the sync', async () => {
        const { service, emit } = failingSetup()
        emit.mockImplementation(() => {
            throw new Error('listener exploded')
        })
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        await expect(service.sync('bcv')).resolves.toMatchObject({ outcome: 'failed' })
    })
})
