import {
    ArgumentsHost,
    BadRequestException,
    Catch,
    type ExceptionFilter,
    HttpException,
    PayloadTooLargeException,
} from '@nestjs/common'
import type { Response } from 'express'
import type { FileInterceptor } from '@nestjs/platform-express'
import { ALLOWED_MEDIA_IMAGE_MIME_TYPES } from '../storage/media-type.js'

export const CATEGORY_IMAGE_FIELD = 'image'
export const MAX_CATEGORY_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_MB = MAX_CATEGORY_IMAGE_BYTES / (1024 * 1024)
export const INVALID_CATEGORY_IMAGE_TYPE =
    'La imagen de portada debe ser un archivo JPG, PNG, WEBP o AVIF.'

/** Multer options for a category cover: one image, 5 MB, only the category's text fields. */
export const CATEGORY_IMAGE_UPLOAD_OPTIONS: NonNullable<Parameters<typeof FileInterceptor>[1]> = {
    limits: { fileSize: MAX_CATEGORY_IMAGE_BYTES, files: 1, fields: 12, fieldSize: 10_000 },
    fileFilter: (_req, file, callback) => {
        if (ALLOWED_MEDIA_IMAGE_MIME_TYPES.has(file.mimetype)) {
            callback(null, true)
            return
        }
        callback(new BadRequestException(INVALID_CATEGORY_IMAGE_TYPE), false)
    },
}

const MULTER_MESSAGES: Record<string, string> = {
    'File too large': `La imagen de portada puede pesar como máximo ${MAX_MB} MB.`,
    'Too many files': 'Adjunta una sola imagen de portada.',
    'Unexpected field': `Adjunta la imagen de portada en el campo "${CATEGORY_IMAGE_FIELD}".`,
    'Multipart: Boundary not found': 'La solicitud debe enviarse como multipart/form-data.',
}

/** Multer (via Nest) reports limits in English; translate them for the admin UI. */
@Catch(PayloadTooLargeException, BadRequestException)
export class CategoryImageUploadErrorsFilter implements ExceptionFilter {
    catch(exception: HttpException, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>()
        const status = exception.getStatus()
        const translated = MULTER_MESSAGES[exception.message]
        response
            .status(status)
            .json(
                translated
                    ? { statusCode: status, error: exception.name, message: translated }
                    : exception.getResponse(),
            )
    }
}
