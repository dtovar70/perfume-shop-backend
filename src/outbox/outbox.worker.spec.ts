import type { ConfigService } from '@nestjs/config'
import type { SchedulerRegistry } from '@nestjs/schedule'
import type { DataSource } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import { OutboxRegistry, type OutboxHandler } from './outbox-handler.js'
import type { ClaimedMessage, OutboxStore } from './outbox.store.js'
import { OUTBOX_BATCH_SIZE, OutboxWorker } from './outbox.worker.js'

function handler(type: string, handle: OutboxHandler['handle']): OutboxHandler {
    return { type, event: 'order.created', wants: () => true, handle }
}

const message = (type: string, attempts = 1): ClaimedMessage => ({
    id: `${type}-id`,
    type,
    payload: { orderId: 'o1' },
    attempts,
})

function setup(batches: ClaimedMessage[][] = []) {
    const store = {
        releaseStuck: vi.fn().mockResolvedValue(0),
        claimDue: vi.fn(() => Promise.resolve(batches.shift() ?? [])),
        markSent: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
    }
    const lockQueries: string[] = []
    const dataSource = {
        createQueryRunner: () => ({
            connect: () => Promise.resolve(),
            query: (sql: string) => {
                lockQueries.push(sql)
                return Promise.resolve([{ locked: true }])
            },
            release: () => Promise.resolve(),
        }),
    }
    const registry = new OutboxRegistry()
    const worker = new OutboxWorker(
        dataSource as unknown as DataSource,
        store as unknown as OutboxStore,
        registry,
        { get: () => 'test' } as unknown as ConfigService<Env, true>,
        {} as SchedulerRegistry,
    )
    return { worker, store, registry, lockQueries }
}

describe('OutboxWorker', () => {
    it('dispatches each message to the handler of its type and marks it sent', async () => {
        const { worker, store, registry } = setup()
        const email = vi.fn().mockResolvedValue(undefined)
        const telegram = vi.fn().mockResolvedValue(undefined)
        registry.register(handler('email.x', email))
        registry.register(handler('telegram.x', telegram))

        await worker.process(message('telegram.x'))

        expect(telegram).toHaveBeenCalledWith({ orderId: 'o1' })
        expect(email).not.toHaveBeenCalled()
        expect(store.markSent).toHaveBeenCalledWith('telegram.x-id')
        expect(store.markFailed).not.toHaveBeenCalled()
    })

    it('records a failure (for the backoff) instead of throwing', async () => {
        const { worker, store, registry } = setup()
        registry.register(handler('email.x', () => Promise.reject(new Error('smtp down'))))
        const failing = message('email.x', 3)

        await expect(worker.process(failing)).resolves.toBeUndefined()

        expect(store.markSent).not.toHaveBeenCalled()
        expect(store.markFailed).toHaveBeenCalledWith(failing, 'smtp down')
    })

    it('fails a message of an unknown type', async () => {
        const { worker, store } = setup()
        await worker.process(message('gone.type'))
        expect(store.markFailed).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'gone.type' }),
            'No outbox handler for "gone.type"',
        )
    })

    it('frees stuck claims, then drains batch after batch under the advisory lock', async () => {
        const full = Array.from({ length: OUTBOX_BATCH_SIZE }, (_, index) => ({
            ...message('email.x'),
            id: `m${index}`,
        }))
        const { worker, store, registry, lockQueries } = setup([full, [message('email.x')]])
        registry.register(handler('email.x', () => Promise.resolve()))

        await worker.wake()

        expect(store.releaseStuck).toHaveBeenCalledOnce()
        expect(store.claimDue).toHaveBeenCalledTimes(2)
        expect(store.markSent).toHaveBeenCalledTimes(OUTBOX_BATCH_SIZE + 1)
        expect(lockQueries[0]).toContain('pg_try_advisory_lock')
        expect(lockQueries.at(-1)).toContain('pg_advisory_unlock')
    })

    it('never overlaps runs: a wake-up during a run schedules exactly one more', async () => {
        const { worker, store, registry } = setup([[message('email.x')]])
        let release!: () => void
        registry.register(
            handler('email.x', () => new Promise<void>((resolve) => (release = resolve))),
        )

        const first = worker.wake()
        await vi.waitFor(() => expect(release).toBeDefined())
        const second = worker.wake()
        const third = worker.wake()
        release()
        await Promise.all([first, second, third])

        // One run for the first wake-up, one more for the two that came during it.
        expect(store.releaseStuck).toHaveBeenCalledTimes(2)
    })

    it('stops waking up once the app shuts down', async () => {
        const { worker, store } = setup()
        await worker.onApplicationShutdown()
        await worker.wake()
        expect(store.claimDue).not.toHaveBeenCalled()
    })
})
