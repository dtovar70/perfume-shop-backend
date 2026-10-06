import { ConflictException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { SchedulerRegistry } from '@nestjs/schedule'
import type { Repository } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import type { Order } from './entities/order.entity.js'
import { EXPIRY_NOTE, OrderExpiryService } from './order-expiry.service.js'
import type { OrderStatusService } from './order-status.service.js'

function setup(overdue: Pick<Order, 'id' | 'code'>[]) {
    const find = vi.fn().mockResolvedValueOnce(overdue).mockResolvedValue([])
    const transition = vi.fn().mockResolvedValue({})
    const addInterval = vi.fn()
    const service = new OrderExpiryService(
        { find } as unknown as Repository<Order>,
        { transition } as unknown as OrderStatusService,
        {
            get: (key: string) => ({ NODE_ENV: 'test', ORDER_EXPIRY_INTERVAL_MINUTES: 10 })[key],
        } as unknown as ConfigService<Env, true>,
        { addInterval } as unknown as SchedulerRegistry,
    )
    return { service, find, transition, addInterval }
}

describe('OrderExpiryService', () => {
    it('expires every unpaid order past its deadline through the status service', async () => {
        const { service, find, transition } = setup([
            { id: '1', code: 'KZ-000001' },
            { id: '2', code: 'KZ-000002' },
        ])
        const now = new Date('2026-09-24T12:00:00Z')

        await expect(service.expireOverdue(now)).resolves.toBe(2)
        const [firstQuery] = find.mock.calls[0] as [{ where: { status: string } }]
        expect(firstQuery.where.status).toBe('PENDIENTE_PAGO')
        expect(transition).toHaveBeenCalledWith(
            'KZ-000001',
            'EXPIRADO',
            { kind: 'system' },
            EXPIRY_NOTE,
        )
        expect(transition).toHaveBeenCalledWith(
            'KZ-000002',
            'EXPIRADO',
            { kind: 'system' },
            EXPIRY_NOTE,
        )
    })

    it('skips an order paid in the meantime (the transition no longer applies)', async () => {
        const { service, transition } = setup([
            { id: '1', code: 'KZ-000001' },
            { id: '2', code: 'KZ-000002' },
        ])
        transition.mockRejectedValueOnce(new ConflictException('paid'))

        await expect(service.expireOverdue()).resolves.toBe(1)
    })

    it('does not schedule anything under NODE_ENV=test', () => {
        const { service, addInterval } = setup([])
        service.onApplicationBootstrap()
        expect(addInterval).not.toHaveBeenCalled()
    })
})
