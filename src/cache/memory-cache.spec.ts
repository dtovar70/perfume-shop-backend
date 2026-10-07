import { MEMORY_CACHE_MAX_ENTRIES, MemoryCache, type CacheEntrySpec } from './memory-cache.js'

const spec = <T>(key: string, ttlMs = 1000): CacheEntrySpec<T> => ({ key, ttlMs })

/** A loader whose promise the test settles by hand. */
function deferredLoader<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const loader = vi.fn(
        () =>
            new Promise<T>((res, rej) => {
                resolve = res
                reject = rej
            }),
    )
    return { loader, resolve: (value: T) => resolve(value), reject: (e: Error) => reject(e) }
}

describe('MemoryCache', () => {
    let cache: MemoryCache

    beforeEach(() => {
        cache = new MemoryCache()
    })

    afterEach(() => vi.useRealTimers())

    it('loads on a miss and serves hits without calling the loader again', async () => {
        const loader = vi.fn().mockResolvedValue(['a'])
        expect(await cache.getOrSet(spec('k'), loader)).toEqual(['a'])
        expect(await cache.getOrSet(spec('k'), loader)).toEqual(['a'])
        expect(loader).toHaveBeenCalledOnce()
    })

    it('reloads once the TTL has passed', async () => {
        vi.useFakeTimers()
        const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
        expect(await cache.getOrSet(spec('k', 60_000), loader)).toBe(1)
        vi.advanceTimersByTime(59_999)
        expect(await cache.getOrSet(spec('k', 60_000), loader)).toBe(1)
        vi.advanceTimersByTime(1)
        expect(await cache.getOrSet(spec('k', 60_000), loader)).toBe(2)
    })

    it('coalesces concurrent misses into one load', async () => {
        const { loader, resolve } = deferredLoader<string>()
        const both = Promise.all([
            cache.getOrSet(spec('k'), loader),
            cache.getOrSet(spec('k'), loader),
        ])
        resolve('v')
        expect(await both).toEqual(['v', 'v'])
        expect(loader).toHaveBeenCalledOnce()
    })

    it('does not cache a failed load', async () => {
        const loader = vi
            .fn()
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValueOnce('ok')
        await expect(cache.getOrSet(spec('k'), loader)).rejects.toThrow('db down')
        expect(await cache.getOrSet(spec('k'), loader)).toBe('ok')
    })

    it('invalidates one key, or every key under a prefix', async () => {
        const loader = vi.fn().mockResolvedValue('v')
        for (const key of ['catalog:a', 'catalog:b', 'content:all']) {
            await cache.getOrSet(spec(key), loader)
        }
        cache.invalidatePrefix('catalog:')
        cache.invalidate('content:all')
        loader.mockClear()
        for (const key of ['catalog:a', 'catalog:b', 'content:all']) {
            await cache.getOrSet(spec(key), loader)
        }
        expect(loader).toHaveBeenCalledTimes(3)
    })

    it('never stores a load that an invalidation overtook', async () => {
        const stale = deferredLoader<string>()
        const pending = cache.getOrSet(spec('k'), stale.loader)
        cache.invalidate('k')
        stale.resolve('stale')
        // Its own caller still gets the value it waited for...
        expect(await pending).toBe('stale')
        // ...but the next reader loads again instead of seeing it.
        expect(await cache.getOrSet(spec('k'), () => Promise.resolve('fresh'))).toBe('fresh')
    })

    it('drops the oldest key past the size limit', async () => {
        const loader = vi.fn((): Promise<number> => Promise.resolve(1))
        for (let index = 0; index <= MEMORY_CACHE_MAX_ENTRIES; index++) {
            await cache.getOrSet(spec(`k${index}`), loader)
        }
        loader.mockClear()
        await cache.getOrSet(spec(`k${MEMORY_CACHE_MAX_ENTRIES}`), loader)
        expect(loader).not.toHaveBeenCalled()
        await cache.getOrSet(spec('k0'), loader)
        expect(loader).toHaveBeenCalledOnce()
    })
})
