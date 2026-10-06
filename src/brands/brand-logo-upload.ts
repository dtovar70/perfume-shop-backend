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
import { ALLOWED_IMAGE_MIME_TYPES } from '../storage/image-type.js'

export const LOGO_FIELD = 'logo'
export const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024
const MAX_MB = MAX_LOGO_SIZE_BYTES / (1024 * 1024)
export const INVALID_LOGO_TYPE = 'El logo debe ser una imagen JPG, PNG o WEBP.'

/** Multer options for a brand logo: one image, 2 MB, only the brand's text fields. */
export const LOGO_UPLOAD_OPTIONS: NonNullable<Parameters<typeof FileInterceptor>[1]> = {
    limits: { fileSize: MAX_LOGO_SIZE_BYTES, files: 1, fields: 12, fieldSize: 10_000 },
    fileFilter: (_req, file, callback) => {
        if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
            callback(null, true)
            return
        }
        callback(new BadRequestException(INVALID_LOGO_TYPE), false)
    },
}

const MULTER_MESSAGES: Record<string, string> = {
    'File too large': `El logo puede pesar como máximo ${MAX_MB} MB.`,
    'Too many files': 'Adjunta un solo logo.',
    'Unexpected field': `Adjunta el logo en el campo "${LOGO_FIELD}".`,
    'Multipart: Boundary not found': 'La solicitud debe enviarse como multipart/form-data.',
}

/** Multer (via Nest) reports limits in English; translate them for the admin UI. */
@Catch(PayloadTooLargeException, BadRequestException)
export class LogoUploadErrorsFilter implements ExceptionFilter {
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
