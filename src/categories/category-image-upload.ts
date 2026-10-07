import { createImageUpload } from '../common/http/image-upload.js'
import { ALLOWED_MEDIA_IMAGE_MIME_TYPES } from '../storage/media-type.js'

export const CATEGORY_IMAGE_FIELD = 'image'
export const MAX_CATEGORY_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_MB = MAX_CATEGORY_IMAGE_BYTES / (1024 * 1024)
export const INVALID_CATEGORY_IMAGE_TYPE =
    'La imagen de portada debe ser un archivo JPG, PNG, WEBP o AVIF.'

/** A category cover: one image, 5 MB, only the category's text fields. */
export const CATEGORY_IMAGE_UPLOAD = createImageUpload({
    limits: { fileSize: MAX_CATEGORY_IMAGE_BYTES, files: 1, fields: 12, fieldSize: 10_000 },
    rejectFile: (file) =>
        ALLOWED_MEDIA_IMAGE_MIME_TYPES.has(file.mimetype) ? null : INVALID_CATEGORY_IMAGE_TYPE,
    messages: {
        fileTooLarge: `La imagen de portada puede pesar como máximo ${MAX_MB} MB.`,
        tooManyFiles: 'Adjunta una sola imagen de portada.',
        unexpectedField: `Adjunta la imagen de portada en el campo "${CATEGORY_IMAGE_FIELD}".`,
    },
})
