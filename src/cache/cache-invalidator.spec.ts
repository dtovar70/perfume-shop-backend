import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { lastValueFrom, of, throwError } from 'rxjs'
import { CacheInvalidator } from './cache-invalidator.js'
import { CACHE_KEYS } from './cache-keys.js'
import { CacheInvalidationInterceptor, InvalidatesCache } from './invalidates-cache.decorator.js'
import { MemoryCache, type CacheEntrySpec } from './memory-cache.js'

describe('CacheInvalidator', () => {
    const cache = new MemoryCache()
    const invalidator = new CacheInvalidator(cache)

    /** Fills every cached value; returns a function listing the keys a second read reloads. */
    async function fillAll() {
        const loader = vi.fn().mockResolvedValue(null)
        const specs: CacheEntrySpec<unknown>[] = [
            CACHE_KEYS.categories(),
            CACHE_KEYS.brands(),
            CACHE_KEYS.facets(undefined),
            CACHE_KEYS.facets('arabes'),
            CACHE_KEYS.featured(8),
            CACHE_KEYS.sitemap(),
            CACHE_KEYS.content(),
            CACHE_KEYS.latestExchangeRate(),
        ]
        for (const spec of specs) await cache.getOrSet(spec, loader)
        const reloaded = async () => {
            const keys: string[] = []
            for (const spec of specs) {
                await cache.getOrSet(spec, () => (keys.push(spec.key), Promise.resolve(null)))
            }
            return keys
        }
        return reloaded
    }

    it('a catalog write drops every catalog list, and only those', async () => {
        const reloaded = await fillAll()
        invalidator.invalidate('catalog')
        expect(await reloaded()).toEqual([
            'catalog:categories',
            'catalog:brands',
            'catalog:facets:*',
            'catalog:facets:arabes',
            'catalog:featured:8',
            'catalog:sitemap',
        ])
    })

    it('content and exchange-rate writes drop only their own value', async () => {
        let reloaded = await fillAll()
        invalidator.invalidate('content')
        expect(await reloaded()).toEqual(['content:all'])

        reloaded = await fillAll()
        invalidator.invalidate('exchange-rate')
        expect(await reloaded()).toEqual(['exchange-rate:latest'])
    })

    it('order events (stock changes) refresh the catalog', async () => {
        const reloaded = await fillAll()
        invalidator.onStockMayHaveChanged()
        expect(await reloaded()).toHaveLength(6)
    })
})

describe('CacheInvalidationInterceptor', () => {
    @InvalidatesCache('catalog')
    class AdminController {
        handler(): void {}
    }

    const invalidator = { invalidate: vi.fn() }
    const interceptor = new CacheInvalidationInterceptor(
        new Reflector(),
        invalidator as unknown as CacheInvalidator,
    )
    const context = (method: string) =>
        ({
            getHandler: () => AdminController.prototype.handler,
            getClass: () => AdminController,
            switchToHttp: () => ({ getRequest: () => ({ method }) }),
        }) as unknown as ExecutionContext

    beforeEach(() => invalidator.invalidate.mockClear())

    it('invalidates the scope after a write, even a failed one', async () => {
        await lastValueFrom(interceptor.intercept(context('PATCH'), { handle: () => of({}) }))
        expect(invalidator.invalidate).toHaveBeenCalledWith('catalog')

        const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) }
        await expect(
            lastValueFrom(interceptor.intercept(context('DELETE'), failing)),
        ).rejects.toThrow('boom')
        expect(invalidator.invalidate).toHaveBeenCalledTimes(2)
    })

    it('leaves the cache alone on reads', async () => {
        await lastValueFrom(interceptor.intercept(context('GET'), { handle: () => of([]) }))
        expect(invalidator.invalidate).not.toHaveBeenCalled()
    })
})
