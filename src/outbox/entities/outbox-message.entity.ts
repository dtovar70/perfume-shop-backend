import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm'

export const OUTBOX_STATUSES = ['pending', 'processing', 'sent', 'failed'] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

/** A notification waiting to be delivered (or already delivered, or given up on). */
@Entity({ name: 'outbox_messages' })
@Index('outbox_messages_status_next_attempt_at_idx', ['status', 'nextAttemptAt'])
@Check(
    'outbox_messages_status_check',
    `"status" IN (${OUTBOX_STATUSES.map((status) => `'${status}'`).join(', ')})`,
)
@Check('outbox_messages_attempts_check', `"attempts" >= 0`)
export class OutboxMessage {
    @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'outbox_messages_pkey' })
    id: string

    /** Which OutboxHandler delivers it ("email.order_received", "telegram.payment_submitted"…). */
    @Column({ type: 'varchar', length: 100 })
    type: string

    /** The domain event the message was recorded for (what the handler needs to deliver it). */
    @Column({ type: 'jsonb' })
    payload: object

    @Column({ type: 'varchar', length: 20, default: 'pending' })
    status: OutboxStatus

    /** Deliveries started so far (counted when a row is claimed). */
    @Column({ type: 'integer', default: 0 })
    attempts: number

    /** When a pending row becomes due; while `processing`, when its claim expires (stuck). */
    @Column({ name: 'next_attempt_at', type: 'timestamptz', precision: 3 })
    nextAttemptAt: Date

    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError: string | null

    @Column({ name: 'created_at', type: 'timestamptz', precision: 3 })
    createdAt: Date

    @Column({ name: 'sent_at', type: 'timestamptz', precision: 3, nullable: true })
    sentAt: Date | null
}
