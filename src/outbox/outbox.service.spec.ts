import { ConflictException, NotFoundException } from '@nestjs/common'
import type { EntityManager, Repository } from 'typeorm'
import type { OutboxMessage } from './entities/outbox-message.entity.js'
import { OutboxRegistry, type OutboxHandler } from './outbox-handler.js'
import { OutboxService } from './outbox.service.js'

const handler = (type: string, event: string, wants = true): OutboxHandler => ({
    type,
    event,
    wants: () => wants,
    handle: () => Promise.resolve(),
})

function setup() {
    const registry = new OutboxRegistry()
    registry.register(handler('email.received', 'order.created'))
    registry.register(handler('telegram.created', 'order.created'))
    registry.register(handler('telegram.resolved', 'order.status_changed', false))
    const messages = {
        update: vi.fn().mockResolvedValue({ affected: 1 }),
        findOneBy: vi.fn(),
    }
    const service = new OutboxService(messages as unknown as Repository<OutboxMessage>, registry)
    const manager = {
        create: (_entity: unknown, value: object) => value,
        insert: vi.fn().mockResolvedValue(undefined),
    }
    return { service, messages, manager }
}

describe('OutboxService', () => {
    it('writes one pending row per interested handler, with the transaction manager', async () => {
        const { service, manager } = setup()
        await service.enqueue(manager as unknown as EntityManager, [
            { name: 'order.created', payload: { orderId: 'o1' } },
            { name: 'order.status_changed', payload: { orderId: 'o1' } },
        ])
        const [, rows] = manager.insert.mock.calls[0] as [unknown, OutboxMessage[]]
        expect(rows.map((row) => [row.type, row.status, row.attempts, row.payload])).toEqual([
            ['email.received', 'pending', 0, { orderId: 'o1' }],
            ['telegram.created', 'pending', 0, { orderId: 'o1' }],
        ])
    })

    it('writes nothing when no handler wants the events', async () => {
        const { service, manager } = setup()
        await service.enqueue(manager as unknown as EntityManager, [
            { name: 'order.refund_updated', payload: {} },
        ])
        expect(manager.insert).not.toHaveBeenCalled()
    })

    it('reschedules a failed message now, with fresh attempts', async () => {
        const { service, messages } = setup()
        const id = '11111111-1111-4111-8111-111111111111'
        const now = new Date()
        messages.findOneBy.mockResolvedValue({
            id,
            type: 'email.received',
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            lastError: 'smtp down',
            createdAt: now,
            sentAt: null,
            payload: {},
        })
        const dto = await service.retry(id)
        expect(messages.update).toHaveBeenCalledWith(
            { id, status: expect.anything() },
            expect.objectContaining({ status: 'pending', attempts: 0 }),
        )
        expect(dto).toMatchObject({ status: 'pending', lastError: 'smtp down' })
    })

    it('answers 404 for unknown ids (even malformed ones) and 409 for sent messages', async () => {
        const { service, messages } = setup()
        await expect(service.retry('not-a-uuid')).rejects.toBeInstanceOf(NotFoundException)

        messages.update.mockResolvedValue({ affected: 0 })
        messages.findOneBy.mockResolvedValue(null)
        await expect(service.retry('11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(
            NotFoundException,
        )

        messages.findOneBy.mockResolvedValue({ status: 'sent' })
        await expect(service.retry('11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(
            ConflictException,
        )
    })
})
