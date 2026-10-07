import {
    Injectable,
    Logger,
    type OnApplicationBootstrap,
    type OnApplicationShutdown,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OnEvent } from '@nestjs/event-emitter'
import { SchedulerRegistry } from '@nestjs/schedule'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import { scheduledJobsEnabled } from '../config/jobs.js'
import { runExclusive } from '../database/advisory-lock.js'
import { ORDER_EVENTS } from '../orders/orders.events.js'
import { OutboxRegistry } from './outbox-handler.js'
import { OutboxStore, type ClaimedMessage } from './outbox.store.js'

const POLL_INTERVAL_NAME = 'outbox-worker'
/** Due messages are picked up within this, even if no event woke the worker. */
export const OUTBOX_POLL_INTERVAL_MS = 5_000
/** Messages claimed per batch; a full batch is followed by another one right away. */
export const OUTBOX_BATCH_SIZE = 10
/** A claim not settled after this is considered abandoned (see OutboxStore.releaseStuck). */
export const OUTBOX_LEASE_MS = 5 * 60_000
const LOCK_NAME = 'outbox-worker'

/**
 * Delivers `outbox_messages`: claims due rows, hands each to the handler of its type and records
 * the outcome (sent, or retried later with backoff, or failed for good). Delivery is
 * at-least-once: a crash between a delivery and its "sent" mark repeats it after the lease.
 *
 * Runs every OUTBOX_POLL_INTERVAL_MS (with the other background jobs), and right after every
 * committed order change so notifications go out at once. One run at a time per process (a
 * wake-up during a run schedules one more run), and one per database thanks to an advisory
 * lock, so several API instances never deliver the same batch twice.
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(OutboxWorker.name)
    private running: Promise<void> | null = null
    private rerun = false
    private stopped = false

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly store: OutboxStore,
        private readonly registry: OutboxRegistry,
        private readonly config: ConfigService<Env, true>,
        private readonly scheduler: SchedulerRegistry,
    ) {}

    onApplicationBootstrap(): void {
        if (!scheduledJobsEnabled(this.config)) return
        void this.wake()
        this.scheduler.addInterval(
            POLL_INTERVAL_NAME,
            setInterval(() => void this.wake(), OUTBOX_POLL_INTERVAL_MS),
        )
    }

    /** Lets an in-flight run finish its message before the process exits. */
    async onApplicationShutdown(): Promise<void> {
        this.stopped = true
        await this.running
    }

    /** Order changes were committed with their outbox rows: deliver them now. */
    @OnEvent(ORDER_EVENTS.created)
    @OnEvent(ORDER_EVENTS.paymentSubmitted)
    @OnEvent(ORDER_EVENTS.statusChanged)
    onOrderEvent(): void {
        void this.wake()
    }

    /**
     * Starts a run, or asks the current one to go again when it ends (rows written meanwhile
     * may not have been due when it claimed). Never rejects. Resolves when the runs are over.
     */
    wake(): Promise<void> {
        if (this.stopped) return Promise.resolve()
        if (this.running) {
            this.rerun = true
            return this.running
        }
        this.running = this.loop().finally(() => {
            this.running = null
        })
        return this.running
    }

    private async loop(): Promise<void> {
        do {
            this.rerun = false
            try {
                await runExclusive(this.dataSource, LOCK_NAME, () => this.drain())
            } catch (error) {
                this.logger.error(`Outbox run failed: ${(error as Error).message}`)
            }
        } while (this.rerun && !this.stopped)
    }

    /** Frees abandoned claims, then delivers due messages batch after batch. */
    private async drain(): Promise<void> {
        const freed = await this.store.releaseStuck()
        if (freed) this.logger.warn(`Released ${freed} stuck outbox message(s)`)
        for (;;) {
            const batch = await this.store.claimDue(OUTBOX_BATCH_SIZE, OUTBOX_LEASE_MS)
            for (const message of batch) await this.process(message)
            if (batch.length < OUTBOX_BATCH_SIZE || this.stopped) return
        }
    }

    /** Hands one message to its handler and records the outcome. Never throws. */
    async process(message: ClaimedMessage): Promise<void> {
        try {
            const handler = this.registry.handler(message.type)
            if (!handler) throw new Error(`No outbox handler for "${message.type}"`)
            await handler.handle(message.payload)
            await this.store.markSent(message.id)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.warn(
                `Outbox ${message.type} ${message.id} failed (attempt ${message.attempts}): ${reason}`,
            )
            await this.store.markFailed(message, reason).catch((markError: unknown) => {
                // The lease will release it; the next attempt runs then.
                this.logger.error(
                    `Could not record the failure of ${message.id}: ${String(markError)}`,
                )
            })
        }
    }
}
