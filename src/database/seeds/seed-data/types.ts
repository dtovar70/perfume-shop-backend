/** Seed-only shapes: the KaiZen starter catalog. */
export type SeedCategorySlug = 'arabes' | 'europeos' | 'mujer' | 'hombre' | 'unisex' | 'sets-regalo'

export type SeedBrandSlug =
    | 'lattafa'
    | 'armaf'
    | 'afnan'
    | 'rasasi'
    | 'maison-alhambra'
    | 'al-haramain'
    | 'carolina-herrera'
    | 'dior'
    | 'versace'
    | 'jean-paul-gaultier'

export type SeedProductTag = 'nuevo' | 'bestseller' | 'oferta'

export interface SeedCategory {
    slug: SeedCategorySlug
    name: string
    tagline: string
    description: string
    colorHex: string
}

export interface SeedBrand {
    slug: SeedBrandSlug
    name: string
    description: string
}

/** A bottle size with its own price difference and stock. */
export interface SeedVariant {
    id: string
    label: string
    priceDelta: number
    volumeMl: number
    stock: number
}

export interface SeedProduct {
    id: string
    sku: string
    slug: string
    name: string
    brand: SeedBrandSlug
    category: SeedCategorySlug
    gender: 'mujer' | 'hombre' | 'unisex'
    concentration: 'EDC' | 'EDT' | 'EDP' | 'PARFUM' | 'EXTRAIT'
    volumeMl: number
    price: number
    compareAtPrice?: number
    olfactoryFamily: string
    notesTop: string[]
    notesHeart: string[]
    notesBase: string[]
    description: string
    highlights: string[]
    tags: SeedProductTag[]
    isFeatured: boolean
    /** Without variants; with variants the product's stock is the sum of theirs. */
    stock: number
    variants: SeedVariant[]
    createdAt: string
}
