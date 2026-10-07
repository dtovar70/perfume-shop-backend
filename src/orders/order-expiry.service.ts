import { ConflictException, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SchedulerRegistry } from '@nestjs/schedule'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, LessThan, Repository } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import { scheduledJobsEnabled } from '../config/jobs.js'
import { runExclusive } from '../database/advisory-lock.js'
import { Order } from './entities/order.entity.js'
import { OrderStatusService } from './order-status.service.js'

const EXPIRY_INTERVAL_NAME = 'orders-expiry'
const EXPIRY_LOCK_NAME = 'orders-expiry'
const BATCH_SIZE = 100
export const EXPIRY_NOTE = 'Venció el plazo de pago.'

/**
 * Unpaid orders (PENDIENTE_PAGO) past their payment deadline become EXPIRADO and give their
 * stock back. Runs every ORDER_EXPIRY_INTERVAL_MINUTES (and once at startup).
 */
@Injectable()
export class OrderExpiryService implements OnApplicationBootstrap {
    private readonly logger = new Logger(OrderExpiryService.name)
    private running = false

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(Order) private readonly orders: Repository<Order>,
        private readonly statuses: OrderStatusService,
        private readonly config: ConfigService<Env, true>,
        private readonly scheduler: SchedulerRegistry,
    ) {}

    onApplicationBootstrap(): void {
        if (!scheduledJobsEnabled(this.config)) return
        const minutes = this.config.get('ORDER_EXPIRY_INTERVAL_MINUTES', { infer: true })
        void this.runSafely()
        this.scheduler.addInterval(
            EXPIRY_INTERVAL_NAME,
            setInterval(() => void this.runSafely(), minutes * 60_000),
        )
    }

    /** Expires every overdue unpaid order; returns how many were expired. */
    async expireOverdue(now = new Date()): Promise<number> {
        let expired = 0
        for (;;) {
            const overdue = await this.orders.find({
                where: { status: 'PENDIENTE_PAGO', paymentDueAt: LessThan(now) },
                select: { id: true, code: true },
                order: { paymentDueAt: 'ASC' },
                take: BATCH_SIZE,
            })
            for (const order of overdue) {
                try {
                    await this.statuses.transition(
                        order.code,
                        'EXPIRADO',
                        { kind: 'system' },
                        EXPIRY_NOTE,
                    )
                    expired += 1
                } catch (error) {
                    // Paid (or cancelled) in the meantime: the transition no longer applies.
                    if (!(error instanceof ConflictException)) throw error
                }
            }
            if (overdue.length < BATCH_SIZE) break
        }
        if (expired) this.logger.log(`Expired ${expired} unpaid order(s)`)
        return expired
    }

    /**
     * The scheduled run: skipped while the previous one is still going, or while another API
     * instance runs it (advisory lock), so two never expire the same orders at once.
     */
    private async runSafely(): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            await runExclusive(this.dataSource, EXPIRY_LOCK_NAME, async () => {
                await this.expireOverdue()
            })
        } catch (error) {
            this.logger.error('Order expiry failed', error as Error)
        } finally {
            this.running = false
        }
    }
}
