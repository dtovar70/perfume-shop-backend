import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CatalogsModule } from '../catalogs/catalogs.module.js'
import { OrdersModule } from '../orders/orders.module.js'
import { AdminTelegramController } from './admin-telegram.controller.js'
import { AdminTelegramService } from './admin-telegram.service.js'
import { TelegramChat } from './entities/telegram-chat.entity.js'
import { TelegramLinkCode } from './entities/telegram-link-code.entity.js'
import { TelegramMessage } from './entities/telegram-message.entity.js'
import { TelegramBotService } from './telegram-bot.service.js'
import { TelegramContactService } from './telegram-contact.service.js'
import { TelegramEventsListener } from './telegram-events.listener.js'
import { TELEGRAM_OUTBOX_HANDLERS } from './telegram-outbox.handlers.js'
import { TelegramPasswordResetChannel } from './telegram-password-reset.channel.js'
import { TelegramPaymentsService } from './telegram-payments.service.js'
import { TelegramStoreService } from './telegram-store.service.js'
import { TelegramUpdatesService } from './telegram-updates.service.js'
import { TelegramWebhookController } from './telegram-webhook.controller.js'

/**
 * Phase 4: the owner's Telegram bot. Notifies linked chats about payments (and, optionally, new
 * orders) and lets them confirm or reject payments through OrderStatusService, like the admin.
 * Off without TELEGRAM_BOT_TOKEN (or with TELEGRAM_ENABLED=false); the rest of the API does not
 * depend on it.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([TelegramChat, TelegramLinkCode, TelegramMessage]),
        OrdersModule,
        CatalogsModule,
    ],
    controllers: [AdminTelegramController, TelegramWebhookController],
    providers: [
        TelegramBotService,
        TelegramStoreService,
        TelegramPaymentsService,
        TelegramUpdatesService,
        TelegramEventsListener,
        AdminTelegramService,
        TelegramPasswordResetChannel,
        TelegramContactService,
        ...TELEGRAM_OUTBOX_HANDLERS,
    ],
    // Password recovery sends its codes through the bot; the contact form checks it can deliver.
    exports: [TelegramPasswordResetChannel, TelegramContactService],
})
export class TelegramModule {}
