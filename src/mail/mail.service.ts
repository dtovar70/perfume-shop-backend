import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { MailDriver } from '../config/env.schema.js'
import { redactEmails } from './mail.transports.js'
import { MAIL_TRANSPORT, type MailTransport, type OutgoingMail } from './mail.types.js'

/**
 * Sends emails through the transport chosen by MAIL_DRIVER. `send` never throws: a mail outage
 * must never fail an order or a password reset, so failures are logged (with the caller's
 * context, never the address or the body) and reported as `false`.
 */
@Injectable()
export class MailService implements OnApplicationBootstrap {
    private readonly logger = new Logger('Mail')

    constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

    onApplicationBootstrap(): void {
        this.logger.log(
            this.transport.delivers
                ? `Mail driver: ${this.transport.driver}`
                : 'Mail driver: log (emails are not sent; set MAIL_DRIVER to smtp or resend)',
        )
    }

    get driver(): MailDriver {
        return this.transport.driver
    }

    /** False with MAIL_DRIVER=log: an email would not reach anyone. */
    get delivers(): boolean {
        return this.transport.delivers
    }

    /**
     * `context` names what is sent for the log ("order received KZ-000123"); it must not carry
     * personal data. Resolves true once the provider accepted the message.
     */
    async send(message: OutgoingMail, context: string): Promise<boolean> {
        try {
            await this.transport.send(message)
            if (this.transport.delivers) {
                this.logger.log(`Email sent (${context}) via ${this.transport.driver}`)
            }
            return true
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.error(
                `Email failed (${context}) via ${this.transport.driver}: ${redactEmails(reason)}`,
            )
            return false
        }
    }
}
