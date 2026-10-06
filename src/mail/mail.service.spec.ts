import { Logger } from '@nestjs/common'
import { MailService } from './mail.service.js'
import type { MailTransport } from './mail.types.js'

const MESSAGE = { to: 'ana@example.com', subject: 'Hola', html: '<p>Hola</p>', text: 'Hola' }

describe('MailService', () => {
    afterEach(() => vi.restoreAllMocks())

    it('sends through the transport', async () => {
        const transport: MailTransport = {
            driver: 'smtp',
            delivers: true,
            send: vi.fn().mockResolvedValue(undefined),
        }
        const mail = new MailService(transport)
        expect(mail.delivers).toBe(true)
        await expect(mail.send(MESSAGE, 'order received KZ-000001')).resolves.toBe(true)
        expect(transport.send).toHaveBeenCalledWith(MESSAGE)
    })

    it('never throws: a failure is logged without the address and reported as false', async () => {
        const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
        const transport: MailTransport = {
            driver: 'resend',
            delivers: true,
            send: vi.fn().mockRejectedValue(new Error('550 ana@example.com: mailbox unavailable')),
        }
        const mail = new MailService(transport)
        await expect(mail.send(MESSAGE, 'order received KZ-000001')).resolves.toBe(false)
        const logged = String(errors.mock.calls[0]?.[0])
        expect(logged).toContain('order received KZ-000001')
        expect(logged).toContain('[email]')
        expect(logged).not.toContain('ana@example.com')
    })
})
