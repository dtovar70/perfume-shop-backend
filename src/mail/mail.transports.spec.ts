import { createServer, type AddressInfo, type Server } from 'node:net'
import type { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env.schema.js'
import {
    createMailTransport,
    LogMailTransport,
    maskEmail,
    redactEmails,
    RESEND_API_URL,
    ResendMailTransport,
    SmtpMailTransport,
} from './mail.transports.js'

const MESSAGE = {
    to: 'ana@example.com',
    subject: 'Recibimos tu pedido KZ-000001',
    html: '<p>Hola</p>',
    text: 'Hola',
}

function config(values: Partial<Env>): ConfigService<Env, true> {
    return { get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>
}

describe('mail transports', () => {
    it('masks and redacts addresses for the logs', () => {
        expect(maskEmail('ana.maria@example.com')).toBe('an***@example.com')
        expect(maskEmail('a@example.com')).toBe('a***@example.com')
        expect(maskEmail('nope')).toBe('***')
        expect(redactEmails('550 <ana@example.com>: Recipient rejected')).toBe(
            '550 <[email]>: Recipient rejected',
        )
    })

    it('posts to Resend with the key, the sender and the reply-to', async () => {
        const fetchFn = vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 }))
        const transport = new ResendMailTransport(
            're_secret',
            { from: 'Tienda <pedidos@example.com>', replyTo: 'hola@example.com' },
            fetchFn as unknown as typeof fetch,
        )
        await transport.send(MESSAGE)
        expect(fetchFn).toHaveBeenCalledTimes(1)
        const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
        expect(url).toBe(RESEND_API_URL)
        expect(init.method).toBe('POST')
        expect(init.headers).toMatchObject({ Authorization: 'Bearer re_secret' })
        expect(JSON.parse(init.body as string)).toEqual({
            from: 'Tienda <pedidos@example.com>',
            to: ['ana@example.com'],
            subject: MESSAGE.subject,
            html: MESSAGE.html,
            text: MESSAGE.text,
            reply_to: 'hola@example.com',
        })
    })

    it('throws when Resend refuses the message', async () => {
        const fetchFn = vi
            .fn()
            .mockResolvedValue(new Response('{"message":"Invalid `from`"}', { status: 422 }))
        const transport = new ResendMailTransport(
            're_secret',
            { from: 'pedidos@example.com', replyTo: undefined },
            fetchFn as unknown as typeof fetch,
        )
        await expect(transport.send(MESSAGE)).rejects.toThrow(/Resend answered 422/)
        const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string)
        expect(body).not.toHaveProperty('reply_to')
    })

    it('picks the transport from MAIL_DRIVER, and always log under NODE_ENV=test', () => {
        const smtp = {
            MAIL_DRIVER: 'smtp',
            MAIL_FROM: 'pedidos@example.com',
            SMTP_HOST: 'localhost',
            SMTP_PORT: 1025,
        } as const
        expect(createMailTransport(config({ NODE_ENV: 'development', ...smtp }))).toBeInstanceOf(
            SmtpMailTransport,
        )
        expect(createMailTransport(config({ NODE_ENV: 'test', ...smtp }))).toBeInstanceOf(
            LogMailTransport,
        )
        const resend = createMailTransport(
            config({
                NODE_ENV: 'production',
                MAIL_DRIVER: 'resend',
                MAIL_FROM: 'pedidos@example.com',
                RESEND_API_KEY: 're_1',
            }),
        )
        expect(resend).toBeInstanceOf(ResendMailTransport)
        expect(resend.delivers).toBe(true)
        const log = createMailTransport(config({ NODE_ENV: 'production', MAIL_DRIVER: 'log' }))
        expect(log.delivers).toBe(false)
    })
})

/**
 * The smallest SMTP server nodemailer can talk to (no STARTTLS, no AUTH): records the envelope
 * and the DATA of each message.
 */
function fakeSmtpServer(): Promise<{
    server: Server
    port: number
    messages: { from: string; to: string[]; data: string }[]
}> {
    const messages: { from: string; to: string[]; data: string }[] = []
    const server = createServer((socket) => {
        let buffer = ''
        let inData = false
        let current = { from: '', to: [] as string[], data: '' }
        socket.write('220 fake.smtp ESMTP\r\n')
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            let newline: number
            while ((newline = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 2)
                if (inData) {
                    if (line === '.') {
                        inData = false
                        messages.push(current)
                        current = { from: '', to: [], data: '' }
                        socket.write('250 OK queued\r\n')
                    } else {
                        current.data += `${line}\n`
                    }
                    continue
                }
                const command = line.slice(0, 4).toUpperCase()
                if (command === 'EHLO' || command === 'HELO') {
                    socket.write('250-fake.smtp\r\n250 8BITMIME\r\n')
                } else if (command === 'MAIL') {
                    current.from = line.replace(/^MAIL FROM:\s*/i, '').replace(/\s.*$/, '')
                    socket.write('250 OK\r\n')
                } else if (command === 'RCPT') {
                    current.to.push(line.replace(/^RCPT TO:\s*/i, '').replace(/\s.*$/, ''))
                    socket.write('250 OK\r\n')
                } else if (command === 'DATA') {
                    inData = true
                    socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
                } else if (command === 'QUIT') {
                    socket.end('221 Bye\r\n')
                } else {
                    socket.write('250 OK\r\n')
                }
            }
        })
    })
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as AddressInfo).port, messages })
        })
    })
}

describe('SmtpMailTransport (nodemailer)', () => {
    let smtp: Awaited<ReturnType<typeof fakeSmtpServer>>

    beforeEach(async () => {
        smtp = await fakeSmtpServer()
    })

    afterEach(async () => {
        await new Promise((resolve) => smtp.server.close(resolve))
    })

    it('delivers the message with the sender, reply-to and both bodies', async () => {
        const transport = new SmtpMailTransport(
            { host: '127.0.0.1', port: smtp.port },
            { from: 'Tienda <pedidos@example.com>', replyTo: 'hola@example.com' },
        )
        await transport.send(MESSAGE)

        expect(smtp.messages).toHaveLength(1)
        const [sent] = smtp.messages
        expect(sent!.from).toBe('<pedidos@example.com>')
        expect(sent!.to).toEqual(['<ana@example.com>'])
        expect(sent!.data).toMatch(/^From: Tienda <pedidos@example\.com>$/m)
        expect(sent!.data).toMatch(/^Reply-To: hola@example\.com$/m)
        expect(sent!.data).toMatch(/^To: ana@example\.com$/m)
        expect(sent!.data).toMatch(/^Subject: Recibimos tu pedido KZ-000001$/m)
        expect(sent!.data).toContain('text/plain')
        expect(sent!.data).toContain('text/html')
    })

    it('fails when the server is unreachable', async () => {
        await new Promise((resolve) => smtp.server.close(resolve))
        smtp.server = createServer()
        smtp.server.listen(0)
        const transport = new SmtpMailTransport(
            { host: '127.0.0.1', port: smtp.port },
            { from: 'pedidos@example.com', replyTo: undefined },
        )
        await expect(transport.send(MESSAGE)).rejects.toThrow()
    })
})
