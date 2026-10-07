import type { DataSource } from 'typeorm'
import { runExclusive } from './advisory-lock.js'

function dataSource(locked: boolean) {
    const runner = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn((sql: string, _params: unknown[]) =>
            Promise.resolve(sql.includes('try') ? [{ locked }] : []),
        ),
        release: vi.fn().mockResolvedValue(undefined),
    }
    return { runner, source: { createQueryRunner: () => runner } as unknown as DataSource }
}

describe('runExclusive', () => {
    it('runs the work holding the lock, then unlocks and releases the connection', async () => {
        const { runner, source } = dataSource(true)
        const work = vi.fn().mockResolvedValue(undefined)

        expect(await runExclusive(source, 'job', work)).toBe(true)

        expect(work).toHaveBeenCalledOnce()
        expect(runner.query.mock.calls).toEqual([
            ['SELECT pg_try_advisory_lock(hashtext($1)) AS "locked"', ['job']],
            ['SELECT pg_advisory_unlock(hashtext($1))', ['job']],
        ])
        expect(runner.release).toHaveBeenCalledOnce()
    })

    it('skips the work while another session holds the lock', async () => {
        const { runner, source } = dataSource(false)
        const work = vi.fn()

        expect(await runExclusive(source, 'job', work)).toBe(false)

        expect(work).not.toHaveBeenCalled()
        expect(runner.query).toHaveBeenCalledOnce()
        expect(runner.release).toHaveBeenCalledOnce()
    })

    it('unlocks and releases even when the work fails', async () => {
        const { runner, source } = dataSource(true)
        await expect(
            runExclusive(source, 'job', () => Promise.reject(new Error('boom'))),
        ).rejects.toThrow('boom')
        expect(runner.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock(hashtext($1))', [
            'job',
        ])
        expect(runner.release).toHaveBeenCalledOnce()
    })
})
