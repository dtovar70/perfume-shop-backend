import { Controller, Get, Header } from '@nestjs/common'
import { Public } from '../common/decorators/public.decorator.js'
import { PublicCache } from '../common/http/public-cache.js'
import { SitemapService } from './sitemap.service.js'

/** Browsers and CDNs may keep it an hour; the server copy is dropped by any catalog write. */
export const SITEMAP_MAX_AGE_SECONDS = 3600

/**
 * Served at the root, `/sitemap.xml`, outside the `/api` prefix (GLOBAL_PREFIX_OPTIONS), so the
 * storefront's robots.txt can point crawlers at `<PUBLIC_API_URL>/sitemap.xml`.
 */
@Public()
@Controller()
export class SitemapController {
    constructor(private readonly sitemap: SitemapService) {}

    @Get('sitemap.xml')
    @Header('Content-Type', 'application/xml; charset=utf-8')
    @PublicCache(SITEMAP_MAX_AGE_SECONDS)
    xml(): Promise<string> {
        return this.sitemap.xml()
    }
}
