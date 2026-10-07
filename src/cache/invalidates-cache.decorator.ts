import {
    applyDecorators,
    type CallHandler,
    type ExecutionContext,
    Injectable,
    type NestInterceptor,
    SetMetadata,
    UseInterceptors,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { finalize, type Observable } from 'rxjs'
import { CacheInvalidator, type CacheScope } from './cache-invalidator.js'

const INVALIDATES_CACHE = 'invalidatesCache'
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Drops the scope's cached values after every write request (POST/PUT/PATCH/DELETE) of the
 * decorated controller or route, whether it succeeded or not: a write that failed half-way
 * (e.g. images stored, then an error) may still have changed something, and a needless
 * invalidation only costs one reload. New write routes are covered without extra code.
 */
export function InvalidatesCache(scope: CacheScope): ClassDecorator & MethodDecorator {
    return applyDecorators(
        SetMetadata(INVALIDATES_CACHE, scope),
        UseInterceptors(CacheInvalidationInterceptor),
    )
}

@Injectable()
export class CacheInvalidationInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly invalidator: CacheInvalidator,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const scope = this.reflector.getAllAndOverride<CacheScope | undefined>(INVALIDATES_CACHE, [
            context.getHandler(),
            context.getClass(),
        ])
        const { method } = context.switchToHttp().getRequest<Request>()
        if (!scope || READ_METHODS.has(method)) return next.handle()
        return next.handle().pipe(finalize(() => this.invalidator.invalidate(scope)))
    }
}
