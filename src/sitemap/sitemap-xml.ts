/** One `<url>` of the sitemap. `path` is relative to the site root ("/catalogo"). */
export interface SitemapEntry {
    path: string
    lastmod?: Date | null
}

const XML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
}

/** Escapes the five XML entities (`&` in a query string must read `&amp;`). */
export function escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char)
}

/** `<siteUrl><path>`, with a single slash between them whatever the inputs. */
export function absoluteUrl(siteUrl: string, path: string): string {
    return `${siteUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * A sitemaps.org `urlset`. `lastmod` is written as a full W3C datetime (UTC); entries without
 * one omit it. Duplicate paths keep their first occurrence.
 */
export function buildSitemapXml(siteUrl: string, entries: readonly SitemapEntry[]): string {
    const seen = new Set<string>()
    const urls: string[] = []
    for (const entry of entries) {
        const loc = absoluteUrl(siteUrl, entry.path)
        if (seen.has(loc)) continue
        seen.add(loc)
        const lastmod =
            entry.lastmod && !Number.isNaN(entry.lastmod.getTime())
                ? `<lastmod>${entry.lastmod.toISOString()}</lastmod>`
                : ''
        urls.push(`  <url><loc>${escapeXml(loc)}</loc>${lastmod}</url>`)
    }
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...urls,
        '</urlset>',
        '',
    ].join('\n')
}
