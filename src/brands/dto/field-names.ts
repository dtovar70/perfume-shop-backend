import { feminine, masculine } from '../../common/validation/messages.js'

/** Spanish names of the brand fields, used to build validation messages. */
export const BRAND_FIELD = {
    slug: masculine('El slug de la marca'),
    name: masculine('El nombre de la marca'),
    logoUrl: masculine('El logo de la marca'),
    description: feminine('La descripción de la marca'),
    sortOrder: feminine('La posición de la marca'),
    isActive: masculine('El estado activo de la marca'),
} as const

export const BRAND_NAME_MAX_LENGTH = 60
export const BRAND_SLUG_MAX_LENGTH = 60
export const BRAND_DESCRIPTION_MAX_LENGTH = 1000
export const BRAND_SORT_ORDER_MAX = 9999
export const BRAND_LOGO_URL_MAX_LENGTH = 500
