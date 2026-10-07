import { Injectable, type OnModuleInit } from '@nestjs/common'
import { OutboxRegistry, type OutboxHandler } from '../../outbox/outbox-handler.js'
import { ORDER_EVENTS, type OrderCreatedEvent } from '../orders.events.js'
import { OrderEmailsService } from './order-emails.service.js'

/**
 * order.created → "Pedido recibido", through the outbox: a mail outage never fails or slows
 * down the checkout, and the email is retried until the provider accepts it. Nothing is
 * recorded while mail is off (MAIL_DRIVER=log).
 *
 * At-least-once: if the process dies between the provider accepting the email and the row
 * being marked sent, the customer gets it twice (each copy with its own private link).
 */
@Injectable()
export class OrderReceivedEmailHandler implements OutboxHandler<OrderCreatedEvent>, OnModuleInit {
    readonly type = 'email.order_received'
    readonly event = ORDER_EVENTS.created

    constructor(
        private readonly registry: OutboxRegistry,
        private readonly emails: OrderEmailsService,
    ) {}

    onModuleInit(): void {
        this.registry.register(this)
    }

    wants(): boolean {
        return this.emails.enabled
    }

    async handle(event: OrderCreatedEvent): Promise<void> {
        const outcome = await this.emails.sendOrderReceived(event.orderId)
        if (outcome === 'failed') {
            throw new Error(`"Order received" email of ${event.code} was not accepted`)
        }
    }
}
