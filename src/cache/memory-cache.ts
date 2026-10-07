import { Injectable } from '@nestjs/common'

/** A cached value's key and how long it lives. Built in cache-keys.ts. */
export interface CacheEntrySpec<T> {
    readonly key: string
    readonly ttlMs: number
    /** Carries the value type only (never set), so `getOrSet` is typed by the key. */
    readonly __value?: T
}

interface Entry {
    value: unknown
    expiresAt: number
}

/** Upper bound on stored keys: query-dependent keys (facets per category) cannot grow memory. */
export const MEMORY_CACHE_MAX_ENTRIES = 500

/**
 * A small in-process cache: a TTL map with per-key loaders, prefix invalidation and in-flight
 * coalescing (concurrent misses of a key share one load).
 *
 * Why not `@nestjs/cache-manager`: it supports Nest 12, but it would add three dependencies
 * (cache-manager, keyv, the Nest module) and still lack two things this app needs: invalidating
 * every key under a prefix, and refusing to store a load that an invalidation overtook (a write
 * landing while a stale read is still in flight must not be cached afterwards).
 *
 * Values are shared by every caller: treat them as read-only. Per process: with several API
 * instances each keeps its own copy, so TTLs bound how long another instance's write can go
 * unseen.
 */
@Injectable()
export class MemoryCache {
    private readonly entries = new Map<string, Entry>()
    private readonly loading = new Map<string, Promise<unknown>>()

    async getOrSet<T>(spec: CacheEntrySpec<T>, loader: () => Promise<T>): Promise<T> {
        const entry = this.entries.get(spec.key)
        if (entry && entry.expiresAt > Date.now()) return entry.value as T

        const pending = this.loading.get(spec.key)
        if (pending) return pending as Promise<T>

        const load = loader().then(
            (value) => {
                // Only the load still registered may store: an invalidation unregisters it.
                if (this.loading.get(spec.key) === load) {
                    this.loading.delete(spec.key)
                    this.store(spec, value)
                }
                return value
            },
            (error: unknown) => {
                if (this.loading.get(spec.key) === load) this.loading.delete(spec.key)
                throw error
            },
        )
        this.loading.set(spec.key, load)
        return load
    }

    invalidate(key: string): void {
        this.entries.delete(key)
        this.loading.delete(key)
    }

    invalidatePrefix(prefix: string): void {
        for (const map of [this.entries, this.loading]) {
            for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key)
        }
    }

    private store(spec: CacheEntrySpec<unknown>, value: unknown): void {
        this.entries.delete(spec.key)
        if (this.entries.size >= MEMORY_CACHE_MAX_ENTRIES) {
            // Maps iterate in insertion order: the first key is the oldest write.
            const oldest = this.entries.keys().next()
            if (!oldest.done) this.entries.delete(oldest.value)
        }
        this.entries.set(spec.key, { value, expiresAt: Date.now() + spec.ttlMs })
    }
}
