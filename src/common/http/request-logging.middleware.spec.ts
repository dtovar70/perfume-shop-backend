import { EventEmitter } from 'node:events'
import { Logger } from '@nestjs/common'
import type { Request, Response } from 'express'
import { RequestLoggingMiddleware, resolveRequestId } from './request-logging.middleware.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fakeExchange(url: string, headers: Record<string, string> = {}) {
    const res = Object.assign(new EventEmitter(), {
        locals: {} as Record<string, unknown>,
        statusCode: 200,
        writableFinished: true,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
            this.headers[name] = value
        },
    })
    const req = {
        method: 'GET',
        originalUrl: url,
        baseUrl: '',
        headers,
        route: undefined as { path: string } | undefined,
    }
    return { req, res }
}

describe('resolveRequestId', () => {
    it('keeps a plain incoming id and replaces a missing or unsafe one', () => {
        expect(resolveRequestId('abc-123')).toBe('abc-123')
        expect(resolveRequestId(undefined)).toMatch(UUID)
        expect(resolveRequestId('bad id\nINJECTED')).toMatch(UUID)
        expect(resolveRequestId('x'.repeat(129))).toMatch(UUID)
        expect(resolveRequestId(['a', 'b'])).toMatch(UUID)
    })
})

describe('RequestLoggingMiddleware', () => {
    let log: ReturnType<typeof vi.spyOn>
    let error: ReturnType<typeof vi.spyOn>
    const middleware = new RequestLoggingMiddleware()

    beforeEach(() => {
        log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
        error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => vi.restoreAllMocks())

    const run = (url: string, headers?: Record<string, string>) => {
        const { req, res } = fakeExchange(url, headers)
        const next = vi.fn()
        middleware.use(req as unknown as Request, res as unknown as Response, next)
        expect(next).toHaveBeenCalledOnce()
        return { req, res }
    }

    it('echoes the incoming request id and logs the route pattern, never the query', () => {
        const { req, res } = run('/api/orders/KZ-000001?t=secret', { 'x-request-id': 'rid-1' })
        expect(res.headers['x-request-id']).toBe('rid-1')
        expect(res.locals.requestId).toBe('rid-1')

        req.route = { path: '/api/orders/:code' }
        res.emit('close')

        expect(log).toHaveBeenCalledOnce()
        const line = String(log.mock.calls[0]?.[0])
        expect(line).toMatch(/^GET \/api\/orders\/:code 200 \d+\.\dms rid=rid-1$/)
        expect(line).not.toContain('secret')
        expect(line).not.toContain('KZ-000001')
    })

    it('generates an id when none comes in and logs unmatched paths without the query', () => {
        const { res } = run('/api/nope?x=1')
        expect(res.headers['x-request-id']).toMatch(UUID)
        res.statusCode = 404
        res.emit('close')
        expect(String(log.mock.calls[0]?.[0])).toMatch(/^GET \/api\/nope 404 /)
    })

    it('logs server errors at error level and flags aborted responses', () => {
        const { res } = run('/api/products')
        res.statusCode = 500
        res.writableFinished = false
        res.emit('close')
        expect(log).not.toHaveBeenCalled()
        expect(String(error.mock.calls[0]?.[0])).toMatch(/^GET \/api\/products 500 \(aborted\) /)
    })

    it('skips the health probe but still tags it with an id', () => {
        const { res } = run('/api/health')
        expect(res.headers['x-request-id']).toMatch(UUID)
        res.emit('close')
        expect(log).not.toHaveBeenCalled()
    })
})
