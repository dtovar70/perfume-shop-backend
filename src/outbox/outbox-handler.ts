import { Injectable } from '@nestjs/common'

/** A domain event as collected during a transaction (e.g. `PendingOrderEvent`). */
export interface OutboxEvent<P extends object = object> {
    name: string
    payload: P
}

/**
 * Delivers one kind of notification for one domain event, through the outbox.
 *
 * Delivery is at-least-once: a message can be handled again after a failure, a crash or a stuck
 * claim, so `handle` must tolerate repeats (skip what an earlier attempt already delivered, or
 * be harmless when repeated). It throws to have the message retried later.
 */
export interface OutboxHandler<P extends object = object> {
    /** Stored as `outbox_messages.type`; never rename one while messages of it may be pending. */
    readonly type: string
    /** The domain event this handler reacts to. */
    readonly event: string
    /**
     * Whether this event needs a delivery from this handler, decided when the event is recorded
     * (e.g. no row at all while the channel is turned off).
     */
    wants(payload: P): boolean
    handle(payload: P): Promise<void>
}

/** Handlers by type and by event; each handler registers itself on module init. */
@Injectable()
export class OutboxRegistry {
    private readonly byType = new Map<string, OutboxHandler>()

    register<P extends object>(handler: OutboxHandler<P>): void {
        if (this.byType.has(handler.type)) {
            throw new Error(`Outbox handler "${handler.type}" is registered twice`)
        }
        this.byType.set(handler.type, handler as OutboxHandler)
    }

    handler(type: string): OutboxHandler | undefined {
        return this.byType.get(type)
    }

    /** The handlers that want a delivery for this event. */
    subscribers(event: OutboxEvent): OutboxHandler[] {
        return [...this.byType.values()].filter(
            (handler) => handler.event === event.name && handler.wants(event.payload),
        )
    }
}
