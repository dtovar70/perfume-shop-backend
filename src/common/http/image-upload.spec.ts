import { BadRequestException, PayloadTooLargeException, type ArgumentsHost } from '@nestjs/common'
import { createImageUpload, type UploadSpec } from './image-upload.js'

const SPEC: UploadSpec = {
    limits: { fileSize: 10, files: 1 },
    rejectFile: (file) => (file.mimetype === 'image/png' ? null : 'Solo PNG.'),
    messages: {
        fileTooLarge: 'Muy grande.',
        tooManyFiles: 'Solo uno.',
        unexpectedField: 'Campo incorrecto.',
    },
}

function filterFile(spec: UploadSpec, mimetype: string) {
    const callback = vi.fn()
    const file = { mimetype, fieldname: 'file' } as Express.Multer.File
    createImageUpload(spec).options.fileFilter?.({} as never, file, callback)
    return callback.mock.calls[0] as [Error | null, boolean]
}

function respond(spec: UploadSpec, exception: BadRequestException | PayloadTooLargeException) {
    const json = vi.fn()
    const status = vi.fn((_code: number) => ({ json }))
    const host = {
        switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost
    createImageUpload(spec).filter.catch(exception, host)
    return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] }
}

describe('createImageUpload', () => {
    it('passes the limits through and accepts allowed types', () => {
        expect(createImageUpload(SPEC).options.limits).toEqual({ fileSize: 10, files: 1 })
        expect(filterFile(SPEC, 'image/png')).toEqual([null, true])
    })

    it('refuses other types with a Spanish 400', () => {
        const [error, accepted] = filterFile(SPEC, 'application/pdf')
        expect(accepted).toBe(false)
        expect(error).toBeInstanceOf(BadRequestException)
        expect((error as BadRequestException).getResponse()).toMatchObject({ message: 'Solo PNG.' })
    })

    it('adds field details to refusals when the form asks for them', () => {
        const [error] = filterFile({ ...SPEC, detailsField: 'proof' }, 'text/plain')
        expect((error as BadRequestException).getResponse()).toEqual({
            statusCode: 400,
            error: 'Bad Request',
            message: 'Solo PNG.',
            details: [{ field: 'proof', errors: ['Solo PNG.'] }],
        })
    })

    it("translates Multer's limit errors and leaves the rest untouched", () => {
        expect(respond(SPEC, new PayloadTooLargeException('File too large'))).toEqual({
            status: 413,
            body: { statusCode: 413, error: 'PayloadTooLargeException', message: 'Muy grande.' },
        })
        expect(
            respond(SPEC, new BadRequestException('Multipart: Boundary not found')).body,
        ).toMatchObject({ message: 'La solicitud debe enviarse como multipart/form-data.' })

        const other = new BadRequestException('Otro error.')
        expect(respond(SPEC, other).body).toEqual(other.getResponse())
    })

    it('adds field details to translated errors when the form asks for them', () => {
        const { body } = respond(
            { ...SPEC, detailsField: 'proof' },
            new BadRequestException('Too many files'),
        )
        expect(body).toMatchObject({ details: [{ field: 'proof', errors: ['Solo uno.'] }] })
    })
})
