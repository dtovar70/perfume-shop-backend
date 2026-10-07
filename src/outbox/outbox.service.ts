import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { isUUID } from 'class-validator'
import { In, Repository, type EntityManager } from 'typeorm'
import { newId } from '../database/id.js'
import type { Paginated } from '../products/product.mapper.js'
import type { OutboxQueryDto } from './dto/outbox-query.dto.js'
import { OutboxMessage, type OutboxStatus } from './entities/outbox-message.entity.js'
import { OutboxRegistry, type OutboxEvent } from './outbox-handler.js'

export const OUTBOX_MESSAGE_NOT_FOUND = 'No encontramos ese mensaje.'
export const OUTBOX_NOT_RETRYABLE = 'Este mensaje ya se envió o se está enviando en este momento.'

/** Waiting or given up on: the only states an admin can (re)schedule. */
const RETRYABLE: OutboxStatus[] = ['pending', 'failed']

export interface AdminOutboxMessageDto {
    id: string
    type: string
    status: OutboxStatus
    attempts: number
    nextAttemptAt: string
    lastError: string | null
    createdAt: string
    sentAt: string | null
    payload: object
}

function toDto(row: OutboxMessage): AdminOutboxMessageDto {
    return {
        id: row.id,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
        payload: row.payload,
    }
}

/** Recording notifications next to the change that causes them, and the admin's view of them. */
@Injectable()
export class OutboxService {
    constructor(
        @InjectRepository(OutboxMessage) private readonly messages: Repository<OutboxMessage>,
        private readonly registry: OutboxRegistry,
    ) {}

    /**
     * One row per handler that wants each event, written with the caller's transaction
     * `manager`: the notifications exist if and only if the change commits. Call it last in the
     * transaction, once every event was collected.
     */
    async enqueue(manager: EntityManager, events: readonly OutboxEvent[]): Promise<void> {
        const now = new Date()
        const rows = events.flatMap((event) =>
            this.registry.subscribers(event).map((handler) =>
                manager.create(OutboxMessage, {
                    id: newId(),
                    type: handler.type,
                    payload: event.payload,
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: now,
                    lastError: null,
                    createdAt: now,
                    sentAt: null,
                }),
            ),
        )
        if (rows.length) await manager.insert(OutboxMessage, rows)
    }

    /** Newest first, optionally of one status (`?status=failed` for the ones that gave up). */
    async list(query: OutboxQueryDto): Promise<Paginated<AdminOutboxMessageDto>> {
        const [rows, total] = await this.messages.findAndCount({
            where: query.status ? { status: query.status } : {},
            order: { createdAt: 'DESC', id: 'ASC' },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
        })
        return {
            items: rows.map(toDto),
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        }
    }

    /**
     * Schedules a failed (or still waiting) message for right now with a fresh set of attempts.
     * The last error stays visible until the next attempt.
     */
    async retry(id: string): Promise<AdminOutboxMessageDto> {
        // The column is a uuid: anything else could only fail in Postgres (a 500), not match.
        if (!isUUID(id)) throw new NotFoundException(OUTBOX_MESSAGE_NOT_FOUND)
        const { affected } = await this.messages.update(
            { id, status: In(RETRYABLE) },
            { status: 'pending', attempts: 0, nextAttemptAt: new Date() },
        )
        const row = await this.messages.findOneBy({ id })
        if (!row) throw new NotFoundException(OUTBOX_MESSAGE_NOT_FOUND)
        if (!affected) throw new ConflictException(OUTBOX_NOT_RETRYABLE)
        return toDto(row)
    }
}
