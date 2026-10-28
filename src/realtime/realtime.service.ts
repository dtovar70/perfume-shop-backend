import { Injectable, type MessageEvent, type OnModuleDestroy } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import {
    filter,
    interval,
    map,
    merge,
    type Observable,
    ReplaySubject,
    Subject,
    takeUntil,
    timer,
} from 'rxjs'
import type { CacheScope } from '../cache/cache-invalidator.js'
import { ORDER_EVENTS } from '../orders/orders.events.js'

/**
 * What a client is told: only WHAT changed, never the data itself, so it refetches through the
 * regular (authorized) endpoints. Public changes are the cache scopes; `order` names the order.
 */
export type RealtimeEvent = { type: CacheScope } | { type: 'order'; code: string }

/** A comment line this often keeps proxies (Caddy, Cloudflare: 100 s) from dropping idle streams. */
export const HEARTBEAT_MS = 25_000

/**
 * In-process fan-out of change notifications to the Server-Sent Events streams. Single instance:
 * with several API instances each would only see its own writes (a shared bus would be needed).
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
    private readonly events = new Subject<RealtimeEvent>()
    /** Replays to late subscribers, so a stream opened during shutdown still ends. */
    private readonly shutdown = new ReplaySubject<void>(1)

    publish(event: RealtimeEvent): void {
        this.events.next(event)
    }

    /** Every order event (emitted after commit), including the expiry job and the admin's. */
    @OnEvent(ORDER_EVENTS.created)
    @OnEvent(ORDER_EVENTS.paymentSubmitted)
    @OnEvent(ORDER_EVENTS.statusChanged)
    @OnEvent(ORDER_EVENTS.refundUpdated)
    onOrderChanged(event: { code: string }): void {
        this.publish({ type: 'order', code: event.code })
    }

    /** The storefront: catalog, content and exchange-rate changes; never orders. */
    publicStream(): Observable<MessageEvent> {
        return this.stream((event) => event.type !== 'order')
    }

    /** One customer's order (the caller has already checked the access token). */
    orderStream(code: string): Observable<MessageEvent> {
        return this.stream((event) => event.type === 'order' && event.code === code)
    }

    /** The back office: everything. Ends when the session does, so a dead session cannot listen on. */
    adminStream(sessionExpiresAt?: Date): Observable<MessageEvent> {
        return this.stream(() => true, sessionExpiresAt)
    }

    /**
     * The events `accepts` lets through plus the heartbeat. Unsubscribing (the client went away)
     * tears down both; app shutdown (or `until`) completes the stream so the response ends.
     */
    private stream(
        accepts: (event: RealtimeEvent) => boolean,
        until?: Date,
    ): Observable<MessageEvent> {
        const events = this.events.pipe(
            filter(accepts),
            map((data): MessageEvent => ({ data })),
        )
        const heartbeat = interval(HEARTBEAT_MS).pipe(
            map((): MessageEvent => ({ comment: 'ping' })),
        )
        const end = until ? merge(this.shutdown, timer(until)) : this.shutdown
        return merge(events, heartbeat).pipe(takeUntil(end))
    }

    onModuleDestroy(): void {
        this.shutdown.next()
        this.shutdown.complete()
    }
}
