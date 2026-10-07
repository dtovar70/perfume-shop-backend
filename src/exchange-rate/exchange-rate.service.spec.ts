import { CacheInvalidator } from '../cache/cache-invalidator.js'
import { MemoryCache } from '../cache/memory-cache.js'
import type { ConfigService } from '@nestjs/config'
import type { EventEmitter2 } from '@nestjs/event-emitter'
import type { SchedulerRegistry } from '@nestjs/schedule'
import type { DataSource, Repository } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import type { ExchangeRate } from './entities/exchange-rate.entity.js'
import { EXCHANGE_RATE_EVENTS } from './exchange-rate.events.js'
import {
    ExchangeRateService,
    isRateStale,
    rateUsableUntil,
    SYNC_FAILURE_ALERT_THRESHOLD,
} from './exchange-rate.service.js'
import type { ExchangeRateProvider } from './providers/rate-provider.js'

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

describe('ExchangeRateService sync alerts', () => {
    const stored = {
        id: 'r1',
        rate: 36.5,
        source: 'bcv',
        effectiveDate: '2026-09-25',
        fetchedAt: new Date('2026-09-24T21:00:00Z'),
        isManual: false,
        createdBy: null,
    } as unknown as ExchangeRate

    function setup() {
        let failing = true
        const provider = (source: 'bcv' | 'dolarapi'): ExchangeRateProvider => ({
            source,
            fetchRate: () =>
                failing
                    ? Promise.reject(new Error(`${source} down`))
                    : Promise.resolve({ rate: 36.5, effectiveDate: '2026-09-25' }),
        })
        const rates = {
            findOne: vi.fn().mockResolvedValue(stored),
            insert: vi.fn().mockResolvedValue(undefined),
        } as unknown as Repository<ExchangeRate>
        const config = {
            get: (key: keyof Env) =>
                ({ EXCHANGE_RATE_MAX_AGE_HOURS: 24, EXCHANGE_RATE_SYNC_INTERVAL_MINUTES: 120 })[
                    key as string
                ],
        } as unknown as ConfigService<Env, true>
        const emit = vi.fn()
        const cache = new MemoryCache()
        const service = new ExchangeRateService(
            {} as DataSource,
            rates,
            [provider('bcv'), provider('dolarapi')],
            config,
            {} as SchedulerRegistry,
            { emit } as unknown as EventEmitter2,
            cache,
            new CacheInvalidator(cache),
        )
        return {
            service,
            emit,
            setFailing: (value: boolean) => {
                failing = value
            },
        }
    }

    async function syncTimes(service: ExchangeRateService, times: number) {
        for (let i = 0; i < times; i++) await service.sync()
    }

    it('alerts once after the threshold of consecutive failures', async () => {
        const { service, emit } = setup()
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        expect(emit).not.toHaveBeenCalled()

        await syncTimes(service, 1)
        expect(emit).toHaveBeenCalledTimes(1)
        expect(emit).toHaveBeenCalledWith(
            EXCHANGE_RATE_EVENTS.syncFailing,
            expect.objectContaining({
                consecutiveFailures: SYNC_FAILURE_ALERT_THRESHOLD,
                errors: [
                    { source: 'bcv', error: 'bcv down' },
                    { source: 'dolarapi', error: 'dolarapi down' },
                ],
                current: expect.objectContaining({
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
        const { service, emit, setFailing } = setup()
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD)
        setFailing(false)
        await syncTimes(service, 2)
        expect(emit).toHaveBeenCalledTimes(2)
        expect(emit).toHaveBeenLastCalledWith(
            EXCHANGE_RATE_EVENTS.syncRecovered,
            expect.objectContaining({
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
        const { service, emit, setFailing } = setup()
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        setFailing(false)
        await syncTimes(service, 1)
        setFailing(true)
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        expect(emit).not.toHaveBeenCalled()
    })

    it('never lets a failing listener break the sync', async () => {
        const { service, emit } = setup()
        emit.mockImplementation(() => {
            throw new Error('listener exploded')
        })
        await syncTimes(service, SYNC_FAILURE_ALERT_THRESHOLD - 1)
        await expect(service.sync()).resolves.toMatchObject({ outcome: 'failed' })
    })
})
