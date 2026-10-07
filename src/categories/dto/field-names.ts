import { feminine, masculine } from '../../common/validation/messages.js'

/** Spanish names of the category fields, used to build validation messages. */
export const CATEGORY_FIELD = {
    slug: masculine('El slug de la categoría'),
    name: masculine('El nombre de la categoría'),
    tagline: masculine('El eslogan de la categoría'),
    description: feminine('La descripción de la categoría'),
    color: masculine('El color de la categoría'),
    sortOrder: feminine('La posición de la categoría'),
    imageUrl: feminine('La imagen de portada de la categoría'),
    removeImage: masculine('El campo para quitar la imagen de portada'),
} as const

export const CATEGORY_NAME_MAX_LENGTH = 60
export const CATEGORY_SLUG_MAX_LENGTH = 60
export const CATEGORY_TAGLINE_MAX_LENGTH = 100
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 1000
export const CATEGORY_SORT_ORDER_MAX = 9999
export const CATEGORY_IMAGE_URL_MAX_LENGTH = 500
