import { SlidingWindowLimiter } from './rate-limiter.js'
import { encodeCallback, parseCallback, type CallbackAction } from './telegram-callbacks.js'
import { hashLinkCode, generateLinkCode } from './link-code.js'
import { isButtonUrl } from './telegram-payments.service.js'
import { chatDisplayName, normalizeOrderCode } from './telegram-updates.service.js'
import type { TelegramChat } from './entities/telegram-chat.entity.js'

const ID = '3f2b8c1e-9a4d-4c2b-8e7f-1a2b3c4d5e6f'

describe('callback data', () => {
    const actions: CallbackAction[] = [
        { type: 'verify', paymentId: ID },
        { type: 'verifyAck', paymentId: ID },
        { type: 'reject', paymentId: ID },
        { type: 'rejectReason', paymentId: ID, reason: 2 },
        { type: 'rejectOther', paymentId: ID },
        { type: 'cancel', paymentId: ID },
        { type: 'unlink', confirm: true },
        { type: 'unlink', confirm: false },
    ]

    it('round-trips every action under 64 bytes', () => {
        for (const action of actions) {
            const data = encodeCallback(action)
            expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
            expect(parseCallback(data)).toEqual(action)
        }
    })

    it('rejects anything malformed', () => {
        for (const data of [
            undefined,
            '',
            'pv:',
            'pv:not-a-uuid',
            `pv:${ID}x`,
            `zz:${ID}`,
            `rq:9:${ID}`,
            `rq:1:${ID.toUpperCase()}`,
            'ux:maybe',
            `pv:${ID}`.repeat(3),
        ]) {
            expect(parseCallback(data)).toBeNull()
        }
    })
})

describe('link codes', () => {
    it('are 6 digits and hashed with the server secret', () => {
        expect(generateLinkCode()).toMatch(/^\d{6}$/)
        const hash = hashLinkCode('482913', 'secret-a')
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
        expect(hashLinkCode('482913', 'secret-b')).not.toBe(hash)
    })
})

describe('SlidingWindowLimiter', () => {
    it('allows `limit` hits per window and key', () => {
        let now = 0
        const limiter = new SlidingWindowLimiter(2, 1000, () => now)
        expect(limiter.hit('a')).toBe(true)
        expect(limiter.hit('a')).toBe(true)
        expect(limiter.hit('a')).toBe(false)
        expect(limiter.hit('b')).toBe(true)
        now = 1000
        expect(limiter.hit('a')).toBe(true)
    })

    it('tells whether a key is limited without counting, and forgets it on reset', () => {
        let now = 0
        const limiter = new SlidingWindowLimiter(2, 1000, () => now)
        expect(limiter.isLimited('a')).toBe(false)
        limiter.hit('a')
        limiter.hit('a')
        expect(limiter.isLimited('a')).toBe(true)
        expect(limiter.isLimited('b')).toBe(false)
        limiter.reset('a')
        expect(limiter.isLimited('a')).toBe(false)
        limiter.hit('a')
        limiter.hit('a')
        now = 1000
        expect(limiter.isLimited('a')).toBe(false)
    })
})

describe('bot helpers', () => {
    it('normalizes order codes', () => {
        expect(normalizeOrderCode('KZ-000012')).toBe('KZ-000012')
        expect(normalizeOrderCode('kz12')).toBe('KZ-000012')
        expect(normalizeOrderCode(' 12 ')).toBe('KZ-000012')
        expect(normalizeOrderCode('KZ-1234567')).toBe('KZ-1234567')
        expect(normalizeOrderCode('pedido')).toBeNull()
        expect(normalizeOrderCode('')).toBeNull()
    })

    it('only uses URL buttons Telegram accepts', () => {
        expect(isButtonUrl('https://kaizen.com/admin/pedidos/KZ-000001')).toBe(true)
        expect(isButtonUrl('http://localhost:5173/admin/pedidos/KZ-000001')).toBe(false)
        expect(isButtonUrl('http://127.0.0.1:5173/x')).toBe(false)
        expect(isButtonUrl('http://intranet/x')).toBe(false)
        expect(isButtonUrl('javascript:alert(1)')).toBe(false)
    })

    it('names the chat by first name, username or linked admin', () => {
        const chat = { firstName: null, username: null, linkedBy: null } as TelegramChat
        expect(chatDisplayName({ ...chat, firstName: 'Ana' })).toBe('Ana')
        expect(chatDisplayName({ ...chat, username: 'ana' })).toBe('@ana')
        expect(chatDisplayName(chat)).toBe('Telegram')
    })
})
