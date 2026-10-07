import { createImageUpload } from '../common/http/image-upload.js'
import {
    ALLOWED_MEDIA_IMAGE_MIME_TYPES,
    ALLOWED_MEDIA_VIDEO_MIME_TYPES,
} from '../storage/media-type.js'

export const HERO_MEDIA_FIELD = 'file'
export const HERO_POSTER_FIELD = 'poster'
export const MAX_HERO_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_HERO_VIDEO_BYTES = 8 * 1024 * 1024
const MB = 1024 * 1024

export const INVALID_HERO_MEDIA_TYPE =
    'La portada debe ser una imagen JPG, PNG, WEBP o AVIF, o un video MP4 o WEBM.'
export const INVALID_HERO_POSTER_TYPE =
    'La imagen previa debe ser una imagen JPG, PNG, WEBP o AVIF.'
export const HERO_IMAGE_TOO_LARGE = `Las imágenes pueden pesar como máximo ${MAX_HERO_IMAGE_BYTES / MB} MB.`

export const HERO_MEDIA_FIELDS = [
    { name: HERO_MEDIA_FIELD, maxCount: 1 },
    { name: HERO_POSTER_FIELD, maxCount: 1 },
]

/**
 * The hero media: one image or video (`file`) and an optional still image (`poster`). Multer's
 * size limit is the larger (video) one; images are held to 5 MB afterwards.
 */
export const HERO_MEDIA_UPLOAD = createImageUpload({
    limits: { fileSize: MAX_HERO_VIDEO_BYTES, files: 2, fields: 4, fieldSize: 1_000 },
    rejectFile: (file) => {
        const isImage = ALLOWED_MEDIA_IMAGE_MIME_TYPES.has(file.mimetype)
        if (file.fieldname === HERO_POSTER_FIELD) return isImage ? null : INVALID_HERO_POSTER_TYPE
        return isImage || ALLOWED_MEDIA_VIDEO_MIME_TYPES.has(file.mimetype)
            ? null
            : INVALID_HERO_MEDIA_TYPE
    },
    messages: {
        fileTooLarge: `El archivo pesa demasiado: los videos pueden pesar hasta ${MAX_HERO_VIDEO_BYTES / MB} MB y las imágenes hasta ${MAX_HERO_IMAGE_BYTES / MB} MB.`,
        tooManyFiles: 'Adjunta un solo archivo y, si quieres, una imagen previa.',
        unexpectedField: `Adjunta el archivo en el campo "${HERO_MEDIA_FIELD}" y la imagen previa en "${HERO_POSTER_FIELD}".`,
    },
})
