import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `outbox_messages`: notifications (customer emails, Telegram messages) recorded in the same
 * transaction as the order change that causes them, and delivered afterwards by OutboxWorker
 * with retries. `status`: pending → processing → sent, or back to pending with a later
 * `next_attempt_at` after a failure, and `failed` once the attempts run out. While a row is
 * `processing`, `next_attempt_at` is its lease: past it, the row is considered stuck.
 *
 * The worker's claim (`status = 'pending' AND next_attempt_at <= now()`, oldest first) reads the
 * `(status, next_attempt_at)` index. `down()` drops the table (undelivered rows are lost).
 */
export class OutboxMessages1792400000000 implements MigrationInterface {
    name = 'OutboxMessages1792400000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "outbox_messages" (
                "id" uuid NOT NULL,
                "type" varchar(100) NOT NULL,
                "payload" jsonb NOT NULL,
                "status" varchar(20) NOT NULL DEFAULT 'pending',
                "attempts" integer NOT NULL DEFAULT 0,
                "next_attempt_at" timestamptz(3) NOT NULL DEFAULT now(),
                "last_error" text,
                "created_at" timestamptz(3) NOT NULL DEFAULT now(),
                "sent_at" timestamptz(3),
                CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "outbox_messages_status_check"
                    CHECK ("status" IN ('pending', 'processing', 'sent', 'failed')),
                CONSTRAINT "outbox_messages_attempts_check" CHECK ("attempts" >= 0)
            )
        `)
        await queryRunner.query(`
            CREATE INDEX "outbox_messages_status_next_attempt_at_idx"
            ON "outbox_messages" ("status", "next_attempt_at")
        `)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "outbox_messages"`)
    }
}
