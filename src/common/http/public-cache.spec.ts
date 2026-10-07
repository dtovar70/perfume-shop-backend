import type { ExecutionContext } from '@nestjs/common'
import { lastValueFrom, of, throwError } from 'rxjs'
import { PublicCacheInterceptor, publicCacheControl } from './public-cache.js'

describe('PublicCacheInterceptor', () => {
    const setup = () => {
        const response = { setHeader: vi.fn() }
        const context = {
            switchToHttp: () => ({ getResponse: () => response }),
        } as unknown as ExecutionContext
        return { response, context, interceptor: new PublicCacheInterceptor(60) }
    }

    it('builds the shared-cache header', () => {
        expect(publicCacheControl(60)).toBe('public, max-age=60, stale-while-revalidate=300')
    })

    it('marks successful responses as publicly cacheable', async () => {
        const { response, context, interceptor } = setup()
        await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }))
        expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            'public, max-age=60, stale-while-revalidate=300',
        )
    })

    it('never marks an error as cacheable', async () => {
        const { response, context, interceptor } = setup()
        const failing = { handle: () => throwError(() => new Error('404')) }
        await expect(lastValueFrom(interceptor.intercept(context, failing))).rejects.toThrow()
        expect(response.setHeader).not.toHaveBeenCalled()
    })
})
