import { createImageUpload } from '../common/http/image-upload.js'
import { ALLOWED_IMAGE_MIME_TYPES } from '../storage/image-type.js'
import { MAX_IMAGES_PER_UPLOAD, MAX_IMAGE_SIZE_BYTES } from './products.constants.js'

export const PRODUCT_IMAGES_FIELD = 'files'
const MAX_MB = MAX_IMAGE_SIZE_BYTES / (1024 * 1024)

/** Product photos: up to MAX_IMAGES_PER_UPLOAD images per request, 5 MB each. */
export const PRODUCT_IMAGES_UPLOAD = createImageUpload({
    limits: { fileSize: MAX_IMAGE_SIZE_BYTES, files: MAX_IMAGES_PER_UPLOAD },
    rejectFile: (file) =>
        ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)
            ? null
            : 'Solo se permiten imágenes JPG, PNG o WEBP.',
    messages: {
        fileTooLarge: `Cada imagen puede pesar como máximo ${MAX_MB} MB.`,
        tooManyFiles: `Puedes subir hasta ${MAX_IMAGES_PER_UPLOAD} imágenes a la vez.`,
        unexpectedField: `Envía hasta ${MAX_IMAGES_PER_UPLOAD} imágenes en el campo "${PRODUCT_IMAGES_FIELD}".`,
    },
})
