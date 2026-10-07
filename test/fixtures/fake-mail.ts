import type { MailTransport, OutgoingMail } from '../../src/mail/mail.types.js'

/** Catches every email instead of sending it. `delivers: false` behaves like MAIL_DRIVER=log. */
export class FakeMailTransport implements MailTransport {
    readonly driver = 'smtp' as const
    delivers = true
    fail = false
    sent: OutgoingMail[] = []

    send(message: OutgoingMail): Promise<void> {
        if (this.fail) return Promise.reject(new Error(`550 ${message.to}: mailbox unavailable`))
        this.sent.push(message)
        return Promise.resolve()
    }
}
