import {
    ArgumentsHost,
    BadRequestException,
    Catch,
    type ExceptionFilter,
    HttpException,
    PayloadTooLargeException,
} from '@nestjs/common'
import type { FileFieldsInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
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
 * Multer options for the hero media: one image or video (`file`) and an optional still image
 * (`poster`). Multer's size limit is the larger (video) one; images are held to 5 MB afterwards.
 */
export const HERO_MEDIA_UPLOAD_OPTIONS: NonNullable<Parameters<typeof FileFieldsInterceptor>[1]> = {
    limits: { fileSize: MAX_HERO_VIDEO_BYTES, files: 2, fields: 4, fieldSize: 1_000 },
    fileFilter: (_req, file, callback) => {
        const isImage = ALLOWED_MEDIA_IMAGE_MIME_TYPES.has(file.mimetype)
        if (file.fieldname === HERO_POSTER_FIELD) {
            if (isImage) callback(null, true)
            else callback(new BadRequestException(INVALID_HERO_POSTER_TYPE), false)
            return
        }
        if (isImage || ALLOWED_MEDIA_VIDEO_MIME_TYPES.has(file.mimetype)) {
            callback(null, true)
            return
        }
        callback(new BadRequestException(INVALID_HERO_MEDIA_TYPE), false)
    },
}

const MULTER_MESSAGES: Record<string, string> = {
    'File too large': `El archivo pesa demasiado: los videos pueden pesar hasta ${MAX_HERO_VIDEO_BYTES / MB} MB y las imágenes hasta ${MAX_HERO_IMAGE_BYTES / MB} MB.`,
    'Too many files': 'Adjunta un solo archivo y, si quieres, una imagen previa.',
    'Unexpected field': `Adjunta el archivo en el campo "${HERO_MEDIA_FIELD}" y la imagen previa en "${HERO_POSTER_FIELD}".`,
    'Multipart: Boundary not found': 'La solicitud debe enviarse como multipart/form-data.',
}

/** Multer (via Nest) reports limits in English; translate them for the admin UI. */
@Catch(PayloadTooLargeException, BadRequestException)
export class HeroMediaUploadErrorsFilter implements ExceptionFilter {
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
