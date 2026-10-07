import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import {
    EXCHANGE_RATE_EVENTS,
    type RateSyncFailingEvent,
    type RateSyncRecoveredEvent,
} from '../exchange-rate/exchange-rate.events.js'
import { CONTACT_EVENTS, type ContactMessageReceivedEvent } from '../contact/contact.events.js'
import { TelegramBotService } from './telegram-bot.service.js'
import { TelegramContactService } from './telegram-contact.service.js'
import { rateSyncFailingMessage, rateSyncRecoveredMessage } from './telegram-format.js'
import { TelegramPaymentsService } from './telegram-payments.service.js'

/** The admin panel's "Tasa BCV" section (frontend ADMIN_ROUTES.exchangeRate). */
const EXCHANGE_RATE_PANEL_PATH = '/admin/tasa-bcv'

/**
 * Rate-sync and contact form events → Telegram. Listeners run asynchronously after the change
 * was committed and never throw: a Telegram outage can never fail or slow down the request (or
 * the rate sync). Order notifications go through the outbox instead (telegram-outbox.handlers),
 * so they are retried until delivered.
 */
@Injectable()
export class TelegramEventsListener {
    private readonly logger = new Logger('TelegramEvents')

    constructor(
        private readonly telegram: TelegramBotService,
        private readonly payments: TelegramPaymentsService,
        private readonly contact: TelegramContactService,
    ) {}

    /** The automatic rate sync kept failing: the admins can load the rate by hand. */
    @OnEvent(EXCHANGE_RATE_EVENTS.syncFailing, { async: true })
    async onRateSyncFailing(event: RateSyncFailingEvent): Promise<void> {
        if (!this.telegram.enabled) return
        await this.safely('rate sync failing', async () => {
            await this.payments.broadcast(rateSyncFailingMessage(event), EXCHANGE_RATE_PANEL_PATH)
        })
    }

    @OnEvent(EXCHANGE_RATE_EVENTS.syncRecovered, { async: true })
    async onRateSyncRecovered(event: RateSyncRecoveredEvent): Promise<void> {
        if (!this.telegram.enabled) return
        await this.safely('rate sync recovered', async () => {
            await this.payments.broadcast(rateSyncRecoveredMessage(event), EXCHANGE_RATE_PANEL_PATH)
        })
    }

    /** The contact form was accepted (it checked a chat could receive it). */
    @OnEvent(CONTACT_EVENTS.messageReceived, { async: true })
    async onContactMessage(event: ContactMessageReceivedEvent): Promise<void> {
        await this.safely('contact message', async () => {
            const delivered = await this.contact.notify(event)
            if (!delivered) {
                this.logger.error(
                    `Contact message from ${event.email} (${event.topic}) reached no Telegram chat`,
                )
            }
        })
    }

    private async safely(what: string, work: () => Promise<void>): Promise<void> {
        try {
            await work()
        } catch (error) {
            this.logger.error(
                `Telegram notification (${what}) failed: ${this.telegram.describe(error)}`,
            )
        }
    }
}
