import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CatalogsModule } from '../catalogs/catalogs.module.js'
import { ContentModule } from '../content/content.module.js'
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module.js'
import { MailModule } from '../mail/mail.module.js'
import { AdminOrdersController } from './admin-orders.controller.js'
import { AdminOrdersService } from './admin-orders.service.js'
import { OrderEmailsService } from './emails/order-emails.service.js'
import { OrderLookupService } from './emails/order-lookup.service.js'
import { OrderReceivedEmailHandler } from './emails/order-received.outbox-handler.js'
import { OrderAccessLink } from './entities/order-access-link.entity.js'
import { OrderItem } from './entities/order-item.entity.js'
import { OrderNote } from './entities/order-note.entity.js'
import { OrderPayment } from './entities/order-payment.entity.js'
import { OrderStatusHistory } from './entities/order-status-history.entity.js'
import { Order } from './entities/order.entity.js'
import { OrderAccessService } from './order-access.service.js'
import { OrderExpiryService } from './order-expiry.service.js'
import { OrderStatusService } from './order-status.service.js'
import { OrdersController } from './orders.controller.js'
import { OrdersService } from './orders.service.js'
import { ReceiptService } from './receipt/receipt.service.js'
import { OrderWhatsAppService } from './whatsapp/order-whatsapp.service.js'

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Order,
            OrderItem,
            OrderPayment,
            OrderStatusHistory,
            OrderNote,
            OrderAccessLink,
        ]),
        CatalogsModule,
        ContentModule,
        ExchangeRateModule,
        MailModule,
    ],
    controllers: [OrdersController, AdminOrdersController],
    providers: [
        OrdersService,
        AdminOrdersService,
        OrderStatusService,
        OrderExpiryService,
        OrderAccessService,
        ReceiptService,
        OrderWhatsAppService,
        OrderEmailsService,
        OrderReceivedEmailHandler,
        OrderLookupService,
    ],
    // The Telegram bot (Phase 4) calls OrderStatusService.transition() like the admin API, reads
    // payment proofs through AdminOrdersService and builds WhatsApp reminders.
    exports: [OrderStatusService, AdminOrdersService, OrderWhatsAppService],
})
export class OrdersModule {}
