import { normalizeText } from '../common/utils/text.util.js'

export interface DerivedSource {
    name: string
    description: string
    tags: string[]
    /** The brand's display name ("Lattafa"), when the product has one. */
    brandName?: string | null
    gender?: string | null
    concentration?: string | null
    olfactoryFamily?: string | null
    notesTop?: readonly string[]
    notesHeart?: readonly string[]
    notesBase?: readonly string[]
    isFeatured?: boolean
}

/**
 * Featured products (+20) first, then bestsellers (+10), then new products (+4). Ties fall back
 * to the newest product (see `CATALOG_ORDER_BY.relevance`). The shop has no reviews, so the
 * seeded `rating` column is deliberately ignored. Stored in `relevance_score` so the database
 * can sort and paginate.
 */
export function computeRelevanceScore(source: Pick<DerivedSource, 'tags' | 'isFeatured'>): number {
    const featuredBoost = source.isFeatured ? 20 : 0
    const bestsellerBoost = source.tags.includes('bestseller') ? 10 : 0
    const newBoost = source.tags.includes('nuevo') ? 4 : 0
    return featuredBoost + bestsellerBoost + newBoost
}

/** Words a customer may type for a tag: the store shows `bestseller` as "favorito". */
const TAG_SEARCH_ALIASES: Record<string, string> = { bestseller: 'favorito' }

/** Words a customer may type for a concentration ("EDP" or "eau de parfum"). */
const CONCENTRATION_SEARCH_ALIASES: Record<string, string> = {
    EDC: 'eau de cologne',
    EDT: 'eau de toilette',
    EDP: 'eau de parfum',
    PARFUM: 'parfum',
    EXTRAIT: 'extrait de parfum',
}

/**
 * Accent-insensitive haystack for search: name, description, brand, gender, concentration (and
 * its long name), olfactory family, notes, tags and their aliases.
 */
export function computeSearchText(source: DerivedSource): string {
    const tagWords = source.tags.flatMap((tag) =>
        TAG_SEARCH_ALIASES[tag] ? [tag, TAG_SEARCH_ALIASES[tag]] : [tag],
    )
    const concentration = source.concentration
        ? [source.concentration, CONCENTRATION_SEARCH_ALIASES[source.concentration] ?? '']
        : []
    return normalizeText(
        [
            source.name,
            source.description,
            source.brandName ?? '',
            source.gender ?? '',
            ...concentration,
            source.olfactoryFamily ?? '',
            ...(source.notesTop ?? []),
            ...(source.notesHeart ?? []),
            ...(source.notesBase ?? []),
            ...tagWords,
        ]
            .filter(Boolean)
            .join(' '),
    )
}

export function computeDerivedFields(source: DerivedSource): {
    searchText: string
    relevanceScore: number
} {
    return { searchText: computeSearchText(source), relevanceScore: computeRelevanceScore(source) }
}
