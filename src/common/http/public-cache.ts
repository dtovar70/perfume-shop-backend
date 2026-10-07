import {
    type CallHandler,
    type ExecutionContext,
    type NestInterceptor,
    UseInterceptors,
} from '@nestjs/common'
import type { Response } from 'express'
import { type Observable, tap } from 'rxjs'

/** How long a stale copy may still be served while the browser or a CDN refreshes it. */
const STALE_WHILE_REVALIDATE_SECONDS = 300

export function publicCacheControl(maxAgeSeconds: number): string {
    return `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`
}

/**
 * Sets `Cache-Control: public` on successful responses only: an error (404 of an unknown slug,
 * a 400) is never stored by browsers or CDNs.
 */
export class PublicCacheInterceptor implements NestInterceptor {
    private readonly header: string

    constructor(maxAgeSeconds: number) {
        this.header = publicCacheControl(maxAgeSeconds)
    }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const response = context.switchToHttp().getResponse<Response>()
        return next.handle().pipe(tap(() => response.setHeader('Cache-Control', this.header)))
    }
}

/**
 * For public storefront GETs whose answer is the same for every visitor (catalog, content,
 * exchange rate). Never on admin, order or auth routes, nor on anything that depends on the
 * session or carries personal data: shared caches would hand it to other people.
 */
export function PublicCache(maxAgeSeconds: number): MethodDecorator & ClassDecorator {
    return UseInterceptors(new PublicCacheInterceptor(maxAgeSeconds))
}
