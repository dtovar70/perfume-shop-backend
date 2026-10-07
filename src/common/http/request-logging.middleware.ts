import { randomUUID } from 'node:crypto'
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

export const REQUEST_ID_HEADER = 'x-request-id'

/**
 * An incoming id is reused (so a proxy's id ties its logs to ours) only when it is short and
 * plain: anything else could forge or break log lines, and is replaced by a fresh UUID.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** The probe polled by the uptime monitor and the container HEALTHCHECK: too chatty to log. */
const HEALTH_PATH = /^\/(?:api\/)?health\/?$/

export function resolveRequestId(incoming: string | string[] | undefined): string {
    return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID()
}

/**
 * Route pattern (`/api/products/:slug`) rather than the real URL: it never logs order codes,
 * tokens or query strings, and groups lines by endpoint. Unmatched requests (404) only have
 * their path, still without the query string.
 */
function routeOf(req: Request): string {
    const pattern = (req.route as { path?: unknown } | undefined)?.path
    return typeof pattern === 'string' ? `${req.baseUrl}${pattern}` : pathOf(req)
}

function pathOf(req: Request): string {
    return req.originalUrl.split('?')[0] ?? req.originalUrl
}

/**
 * One line per request (method, route, status, duration, request id) once the response is
 * done, and the id echoed in `X-Request-Id`. A middleware rather than an interceptor so requests
 * stopped by guards, the throttler or the router (401/403/429/404) are logged too.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
    private readonly logger = new Logger('HTTP')

    use(req: Request, res: Response, next: NextFunction): void {
        const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER])
        res.locals.requestId = requestId
        res.setHeader(REQUEST_ID_HEADER, requestId)
        if (HEALTH_PATH.test(pathOf(req))) return next()

        const startedAt = process.hrtime.bigint()
        res.once('close', () => {
            const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
            const aborted = res.writableFinished ? '' : ' (aborted)'
            const line = `${req.method} ${routeOf(req)} ${res.statusCode}${aborted} ${ms.toFixed(1)}ms rid=${requestId}`
            if (res.statusCode >= 500) this.logger.error(line)
            else this.logger.log(line)
        })
        next()
    }
}
