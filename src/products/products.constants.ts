export const PRODUCT_TAGS = ['nuevo', 'bestseller', 'oferta'] as const
export type ProductTag = (typeof PRODUCT_TAGS)[number]

export const SORT_OPTIONS = ['relevance', 'price-asc', 'price-desc', 'newest', 'name-asc'] as const
export type SortOption = (typeof SORT_OPTIONS)[number]
/** Sorts that no longer exist but may live on in bookmarked URLs; they fall back to relevance. */
export const RETIRED_SORT_OPTIONS: readonly string[] = ['rating']

export const PRODUCT_GENDERS = ['mujer', 'hombre', 'unisex'] as const
export type ProductGender = (typeof PRODUCT_GENDERS)[number]

/** Eau de Cologne, Eau de Toilette, Eau de Parfum, Parfum and Extrait de Parfum. */
export const PRODUCT_CONCENTRATIONS = ['EDC', 'EDT', 'EDP', 'PARFUM', 'EXTRAIT'] as const
export type ProductConcentration = (typeof PRODUCT_CONCENTRATIONS)[number]

/** Olfactory notes per tier (top, heart, base): at most this many, each a single-line text. */
export const PRODUCT_MAX_NOTES = 12
export const PRODUCT_NOTE_MAX_LENGTH = 60
export const PRODUCT_FAMILY_MAX_LENGTH = 60
export const PRODUCT_SKU_MAX_LENGTH = 40
/** A bottle size in milliliters (also for variants). */
export const PRODUCT_MAX_VOLUME_ML = 5000

export const DEFAULT_PAGE_SIZE = 12
export const MAX_PAGE_SIZE = 48
/** The admin products list pages by 10 like every other admin list; the store grid keeps 12. */
export const ADMIN_DEFAULT_PAGE_SIZE = 10
/** Default and maximum `limit` for the featured and related endpoints. */
export const FEATURED_LIMIT = 8
export const MAX_FEATURED_LIMIT = 24
export const RELATED_LIMIT = 4
export const MAX_RELATED_LIMIT = 12

/** Multi-line description (a textarea); enforced by the DTO and a CHECK on the column. */
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 4000
/** "Detalles destacados": at most this many, each a single-line text. */
export const PRODUCT_MAX_HIGHLIGHTS = 6

export const MAX_IMAGES_PER_UPLOAD = 8
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024

/** `POST /products/availability`: cart lines per request (the checkout allows 50 lines). */
export const AVAILABILITY_MAX_ITEMS = 50
/** Longest product or variant id accepted there (the same limit as the order lines). */
export const AVAILABILITY_ID_MAX_LENGTH = 80

export const PRODUCT_NOT_FOUND = 'No encontramos el producto solicitado.'
