import {
    type ArgumentsHost,
    BadRequestException,
    Catch,
    type ExceptionFilter,
    HttpException,
    PayloadTooLargeException,
} from '@nestjs/common'
import type { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'

/** Multer options, as taken by FileInterceptor, FilesInterceptor and FileFieldsInterceptor. */
export type UploadOptions = NonNullable<Parameters<typeof FileInterceptor>[1]>

/** What Multer knows of a file before reading it (name, field, declared type). */
type IncomingFile = Parameters<NonNullable<UploadOptions['fileFilter']>>[1]

/** Spanish replacements for Multer's English limit errors, specific to each form. */
export interface UploadErrorMessages {
    fileTooLarge: string
    tooManyFiles: string
    unexpectedField: string
}

export interface UploadSpec {
    limits: NonNullable<UploadOptions['limits']>
    messages: UploadErrorMessages
    /** Why a file is refused by its type (Spanish), or null to accept it. */
    rejectFile: (file: IncomingFile) => string | null
    /**
     * Form field to name in a `details` entry of every error: forms that show errors under
     * each field (the public payment form) need it; the admin forms only read `message`.
     */
    detailsField?: string
}

/** Multer options and the matching error filter of one upload form. */
export interface Upload {
    options: UploadOptions
    filter: UploadErrorsFilter
}

const BOUNDARY_NOT_FOUND = 'La solicitud debe enviarse como multipart/form-data.'

function errorBody(status: number, error: string, message: string, detailsField?: string) {
    return {
        statusCode: status,
        error,
        message,
        ...(detailsField && { details: [{ field: detailsField, errors: [message] }] }),
    }
}

/**
 * Multer (via Nest) reports limits in English; this translates them for the forms. Any other
 * 400/413 (validation, a refused file type) goes out unchanged.
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class UploadErrorsFilter implements ExceptionFilter {
    private readonly translations: Record<string, string>

    constructor(
        messages: UploadErrorMessages,
        private readonly detailsField?: string,
    ) {
        this.translations = {
            'File too large': messages.fileTooLarge,
            'Too many files': messages.tooManyFiles,
            'Unexpected field': messages.unexpectedField,
            'Multipart: Boundary not found': BOUNDARY_NOT_FOUND,
        }
    }

    catch(exception: HttpException, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>()
        const status = exception.getStatus()
        const translated = this.translations[exception.message]
        response
            .status(status)
            .json(
                translated
                    ? errorBody(status, exception.name, translated, this.detailsField)
                    : exception.getResponse(),
            )
    }
}

/**
 * One upload form (images, or the hero's image/video): Multer options that refuse a wrong file
 * type with a Spanish 400 before it is buffered whole, and the filter translating Multer's
 * limit errors. Use both on the route: `@UseFilters(upload.filter)` and
 * `@UseInterceptors(FileInterceptor(field, upload.options))`.
 */
export function createImageUpload(spec: UploadSpec): Upload {
    const { detailsField } = spec
    return {
        options: {
            limits: spec.limits,
            fileFilter: (_req, file, callback) => {
                const reason = spec.rejectFile(file)
                if (reason === null) {
                    callback(null, true)
                    return
                }
                callback(
                    new BadRequestException(
                        detailsField ? errorBody(400, 'Bad Request', reason, detailsField) : reason,
                    ),
                    false,
                )
            },
        },
        filter: new UploadErrorsFilter(spec.messages, detailsField),
    }
}
