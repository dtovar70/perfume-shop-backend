import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { ContentService } from '../../content/content.service.js'
import { isPaymentConfigured } from '../../content/content.types.js'
import { MailService } from '../../mail/mail.service.js'
import { Order } from '../entities/order.entity.js'
import { OrderAccessService } from '../order-access.service.js'
import { orderLinkEmail, orderReceivedEmail } from './order-emails.js'

/**
 * Customer emails about an order. Each one carries a fresh private link (issued here, never the
 * checkout token: only hashes are stored). Links are issued only when mail really goes out
 * (`MailService.delivers`), so MAIL_DRIVER=log leaves no unused links behind.
 */
@Injectable()
export class OrderEmailsService {
    private readonly logger = new Logger('OrderEmails')

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly content: ContentService,
        private readonly access: OrderAccessService,
        private readonly mail: MailService,
    ) {}

    get enabled(): boolean {
        return this.mail.delivers
    }

    /**
     * "Pedido recibido" to the order's email. `skipped` when there is nothing to send (mail off,
     * order gone), `failed` when the provider did not accept it (worth retrying).
     */
    async sendOrderReceived(orderId: string): Promise<'sent' | 'skipped' | 'failed'> {
        if (!this.enabled) return 'skipped'
        const order = await this.dataSource
            .getRepository(Order)
            .findOne({ where: { id: orderId }, relations: { items: true } })
        if (!order) {
            this.logger.warn(`Order ${orderId} not found; no "order received" email`)
            return 'skipped'
        }
        const content = await this.content.getAll()
        const link = await this.access.issue(order.id, order.code, null)
        const email = orderReceivedEmail(
            { ...order, items: order.items ?? [] },
            isPaymentConfigured(content.payment) ? content.payment : null,
            link.url,
            { brandName: content.general.brandName, contact: content.contact },
        )
        const sent = await this.mail.send(
            { to: order.customerEmail, ...email },
            `order received ${order.code}`,
        )
        return sent ? 'sent' : 'failed'
    }

    /** "Consultar mi pedido": a fresh link to the order's own email. */
    async sendAccessLink(
        order: Pick<Order, 'id' | 'code' | 'customerName' | 'customerEmail'>,
    ): Promise<boolean> {
        if (!this.enabled) return false
        const content = await this.content.getAll()
        const link = await this.access.issue(order.id, order.code, null)
        const email = orderLinkEmail(order, link.url, {
            brandName: content.general.brandName,
            contact: content.contact,
        })
        return this.mail.send({ to: order.customerEmail, ...email }, `order link ${order.code}`)
    }
}
