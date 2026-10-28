import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { ORDER_EVENTS } from '../orders/orders.events.js'
import { RealtimeService } from '../realtime/realtime.service.js'
import { CACHE_KEYS, CATALOG_PREFIX, EXCHANGE_RATE_PREFIX } from './cache-keys.js'
import { MemoryCache } from './memory-cache.js'

/**
 * The groups of cached values a write can make stale. `catalogs` (order statuses, banks, mobile
 * prefixes) has no entry here, since its services drop their own copy, but browsers cache it too.
 */
export type CacheScope = 'catalog' | 'catalogs' | 'content' | 'exchange-rate'

/**
 * The one place that decides what each kind of write invalidates. Admin controllers reach it
 * through `@InvalidatesCache(scope)`, services that write outside a request (the BCV sync)
 * call it directly, and order events (emitted after commit) cover stock changes. Every
 * invalidation is also pushed to the open browsers (SSE), which refetch their own copies.
 */
@Injectable()
export class CacheInvalidator {
    constructor(
        private readonly cache: MemoryCache,
        private readonly realtime: RealtimeService,
    ) {}

    invalidate(scope: CacheScope): void {
        this.dropCached(scope)
        this.realtime.publish({ type: scope })
    }

    private dropCached(scope: CacheScope): void {
        switch (scope) {
            case 'catalog':
                this.cache.invalidatePrefix(CATALOG_PREFIX)
                return
            case 'catalogs':
                return
            case 'content':
                this.cache.invalidate(CACHE_KEYS.content().key)
                return
            case 'exchange-rate':
                this.cache.invalidatePrefix(EXCHANGE_RATE_PREFIX)
                return
        }
    }

    /**
     * Orders take stock when placed, give it back when cancelled or expired, and a late payment
     * can take it again: the catalog shows stock (and "agotado"), so each of these refreshes it.
     * Synchronous on purpose: the next storefront read must already miss.
     */
    @OnEvent(ORDER_EVENTS.created)
    @OnEvent(ORDER_EVENTS.paymentSubmitted)
    @OnEvent(ORDER_EVENTS.statusChanged)
    onStockMayHaveChanged(): void {
        this.invalidate('catalog')
    }
}
