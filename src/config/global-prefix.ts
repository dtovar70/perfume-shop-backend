import { type INestApplication, RequestMethod } from '@nestjs/common'

/** Not exported by @nestjs/common's entry point. */
type GlobalPrefixOptions = NonNullable<Parameters<INestApplication['setGlobalPrefix']>[1]>

/** Every API route lives under `/api`. */
export const API_PREFIX = 'api'

/**
 * Routes served at the root instead: crawlers look for `/sitemap.xml`, so it sits next to
 * `/uploads` rather than under `/api`. Shared by `main.ts` and the e2e suites that need it.
 */
export const GLOBAL_PREFIX_OPTIONS: GlobalPrefixOptions = {
    exclude: [{ path: 'sitemap.xml', method: RequestMethod.GET }],
}
