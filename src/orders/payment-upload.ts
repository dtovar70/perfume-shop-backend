import { createImageUpload } from '../common/http/image-upload.js'
import { ALLOWED_IMAGE_MIME_TYPES } from '../storage/image-type.js'

export const PROOF_FIELD = 'proof'
export const MAX_PROOF_SIZE_BYTES = 5 * 1024 * 1024
const MAX_MB = MAX_PROOF_SIZE_BYTES / (1024 * 1024)
export const INVALID_PROOF_TYPE = 'La captura debe ser una imagen JPG, PNG o WEBP.'

/**
 * The payment screenshot: one image, 5 MB, only a few text fields. Errors keep the usual
 * `{ message, details }` body, so the form shows them under the proof field.
 */
export const PROOF_UPLOAD = createImageUpload({
    limits: { fileSize: MAX_PROOF_SIZE_BYTES, files: 1, fields: 12, fieldSize: 10_000 },
    rejectFile: (file) => (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype) ? null : INVALID_PROOF_TYPE),
    messages: {
        fileTooLarge: `La captura puede pesar como máximo ${MAX_MB} MB.`,
        tooManyFiles: 'Adjunta una sola captura.',
        unexpectedField: `Adjunta la captura en el campo "${PROOF_FIELD}".`,
    },
    detailsField: PROOF_FIELD,
})
