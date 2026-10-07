import { createImageUpload } from '../common/http/image-upload.js'
import { ALLOWED_IMAGE_MIME_TYPES } from '../storage/image-type.js'

export const LOGO_FIELD = 'logo'
export const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024
const MAX_MB = MAX_LOGO_SIZE_BYTES / (1024 * 1024)
export const INVALID_LOGO_TYPE = 'El logo debe ser una imagen JPG, PNG o WEBP.'

/** A brand logo: one image, 2 MB, only the brand's text fields. */
export const LOGO_UPLOAD = createImageUpload({
    limits: { fileSize: MAX_LOGO_SIZE_BYTES, files: 1, fields: 12, fieldSize: 10_000 },
    rejectFile: (file) => (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype) ? null : INVALID_LOGO_TYPE),
    messages: {
        fileTooLarge: `El logo puede pesar como máximo ${MAX_MB} MB.`,
        tooManyFiles: 'Adjunta un solo logo.',
        unexpectedField: `Adjunta el logo en el campo "${LOGO_FIELD}".`,
    },
})
