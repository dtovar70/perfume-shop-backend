import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { nextAttemptAt, OUTBOX_MAX_ATTEMPTS } from './outbox-backoff.js'

/** A claimed message, ready to hand to its handler. */
export interface ClaimedMessage {
    id: string
    type: string
    payload: object
    /** Including the attempt that is starting now. */
    attempts: number
}

/** What TypeORM's `query()` resolves to for an UPDATE … RETURNING: the rows and their count. */
type UpdateReturning<T> = [T[], number]

/** `last_error` keeps the start of long errors (stack-free messages are short anyway). */
const MAX_ERROR_LENGTH = 2000

/**
 * The worker's side of `outbox_messages`, in plain SQL: claiming due rows (safe with several
 * workers at once), recording outcomes and freeing claims abandoned by a crash.
 */
@Injectable()
export class OutboxStore {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * Marks up to `limit` due rows `processing` and returns them, in one statement. `FOR UPDATE
     * SKIP LOCKED` makes concurrent workers (other instances) take different rows instead of
     * waiting on each other. `next_attempt_at` becomes the claim's lease: a row still
     * `processing` after `leaseMs` is considered stuck (see `releaseStuck`).
     */
    async claimDue(limit: number, leaseMs: number): Promise<ClaimedMessage[]> {
        const [rows] = (await this.dataSource.query(
            `UPDATE "outbox_messages" m
             SET "status" = 'processing',
                 "attempts" = m."attempts" + 1,
                 "next_attempt_at" = now() + $2 * interval '1 millisecond'
             WHERE m."id" IN (
                 SELECT "id" FROM "outbox_messages"
                 WHERE "status" = 'pending' AND "next_attempt_at" <= now()
                 ORDER BY "next_attempt_at", "created_at"
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED
             )
             RETURNING m."id", m."type", m."payload", m."attempts"`,
            [limit, leaseMs],
        )) as UpdateReturning<ClaimedMessage>
        return rows
    }

    async markSent(id: string): Promise<void> {
        await this.dataSource.query(
            `UPDATE "outbox_messages"
             SET "status" = 'sent', "sent_at" = now(), "last_error" = NULL
             WHERE "id" = $1 AND "status" = 'processing'`,
            [id],
        )
    }

    /** Back to `pending` with the backoff delay, or `failed` once the attempts ran out. */
    async markFailed(message: ClaimedMessage, error: string, now = new Date()): Promise<void> {
        const retryAt = nextAttemptAt(message.attempts, now)
        await this.dataSource.query(
            `UPDATE "outbox_messages"
             SET "status" = $2, "next_attempt_at" = COALESCE($3, "next_attempt_at"),
                 "last_error" = $4
             WHERE "id" = $1 AND "status" = 'processing'`,
            [message.id, retryAt ? 'pending' : 'failed', retryAt, error.slice(0, MAX_ERROR_LENGTH)],
        )
    }

    /**
     * Claims whose lease ran out (the process died or hung mid-delivery) go back to `pending`
     * (or to `failed` when that was their last attempt). Returns how many were freed.
     */
    async releaseStuck(): Promise<number> {
        const [rows] = (await this.dataSource.query(
            `UPDATE "outbox_messages"
             SET "status" = CASE WHEN "attempts" >= $1 THEN 'failed' ELSE 'pending' END,
                 "last_error" = COALESCE("last_error", 'Interrumpido durante el envío.'),
                 "next_attempt_at" = now()
             WHERE "status" = 'processing' AND "next_attempt_at" < now()
             RETURNING "id"`,
            [OUTBOX_MAX_ATTEMPTS],
        )) as UpdateReturning<{ id: string }>
        return rows.length
    }
}
