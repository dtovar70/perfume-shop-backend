import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { Repository } from 'typeorm'
import { Role } from '../auth/role.enum.js'
import type { BanksService } from '../catalogs/banks.service.js'
import {
    unavailablePrefixMessage,
    type MobilePrefixesService,
} from '../catalogs/mobile-prefixes.service.js'
import type { AuthUser } from '../common/types/auth-user.js'
import type { StorageService } from '../storage/storage.service.js'
import { DEFAULT_SITE_CONTENT } from './content.defaults.js'
import { ContentService, mergeSection } from './content.service.js'
import { CONTENT_SECTIONS } from './content.types.js'
import type { SiteContentEntry } from './entities/site-content.entity.js'

const USER: AuthUser = {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Admin',
    role: Role.ADMIN,
    createdAt: new Date(),
    updatedAt: new Date(),
}

const STORAGE_URL = 'http://api.test/uploads'

/** Smallest signatures `detectMediaType` recognizes. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const MP4_BYTES = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypisom\0\0\x02\0isomiso2', 'binary'),
])

function multerFile(buffer: Buffer, size = buffer.length): Express.Multer.File {
    return { buffer, size, originalname: 'file', mimetype: 'application/octet-stream' } as never
}

function setup(rows: Partial<SiteContentEntry>[] = []) {
    const entries = {
        find: vi.fn().mockResolvedValue(rows),
        findOne: vi.fn().mockResolvedValue(null),
        query: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue({ affected: 1 }),
    }
    /** The `banks` catalog: 0102 is active, 0104 exists but was deactivated. */
    const banks = {
        findActive: vi.fn((code: string) =>
            Promise.resolve(
                code === '0102'
                    ? { code, name: 'Banco de Venezuela', isActive: true, sortOrder: 0 }
                    : null,
            ),
        ),
    }
    /** The `mobile_prefixes` catalog: 0426 exists but is inactive. */
    const activePrefixes = ['0412', '0414', '0416', '0422', '0424']
    const mobilePrefixes = {
        phoneProblem: vi.fn((phone: string) =>
            Promise.resolve(
                activePrefixes.includes(phone.slice(0, 4))
                    ? null
                    : unavailablePrefixMessage(phone.slice(0, 4)),
            ),
        ),
    }
    /** Local-like storage: our hero uploads live under `${STORAGE_URL}/hero/`. */
    const storage = {
        uploadMedia: vi.fn((media: { type: string }) => {
            const extension = media.type === 'jpeg' ? 'jpg' : media.type
            const publicId = `hero/file-${storage.uploadMedia.mock.calls.length}.${extension}`
            return Promise.resolve({ url: `${STORAGE_URL}/${publicId}`, publicId })
        }),
        mediaFromUrl: vi.fn((url: string) => {
            if (!url.startsWith(`${STORAGE_URL}/hero/`)) return null
            const publicId = url.slice(STORAGE_URL.length + 1)
            return { publicId, kind: /\.(mp4|webm)$/.test(publicId) ? 'video' : 'image' }
        }),
        deleteMedia: vi.fn().mockResolvedValue(undefined),
    }
    const service = new ContentService(
        entries as unknown as Repository<SiteContentEntry>,
        banks as unknown as BanksService,
        mobilePrefixes as unknown as MobilePrefixesService,
        storage as unknown as StorageService,
    )
    return { service, entries, banks, mobilePrefixes, storage }
}

/** The validation error details of a rejected update. */
async function detailsOf(
    promise: Promise<unknown>,
): Promise<{ field: string; errors: string[] }[]> {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BadRequestException)
    return ((error as BadRequestException).getResponse() as { details: never[] }).details
}

describe('mergeSection', () => {
    it('returns a copy of the defaults when nothing is stored', () => {
        const merged = mergeSection('shipping', undefined)
        expect(merged).toEqual(DEFAULT_SITE_CONTENT.shipping)
        expect(merged).not.toBe(DEFAULT_SITE_CONTENT.shipping)
    })

    it('keeps stored fields, fills the missing ones and drops unknown or mistyped ones', () => {
        const merged = mergeSection('shipping', {
            flatRate: 6,
            freeThreshold: '50',
            legacyField: 'x',
        })
        expect(merged).toEqual({ ...DEFAULT_SITE_CONTENT.shipping, flatRate: 6 })
    })

    it('gives a home row saved before testimonials existed an empty list', () => {
        const { testimonials: _testimonials, ...stored } = {
            ...DEFAULT_SITE_CONTENT.home,
            heroBadge: 'Hecho a mano',
        }
        const merged = mergeSection('home', stored)
        expect(merged.testimonials).toEqual([])
        expect(merged.heroBadge).toBe('Hecho a mano')
    })
})

describe('ContentService', () => {
    it('getAll merges the stored sections over the defaults', async () => {
        const { service } = setup([{ key: 'announcements', value: { messages: ['Solo hoy'] } }])
        const content = await service.getAll()
        expect(Object.keys(content)).toEqual([...CONTENT_SECTIONS])
        expect(content.announcements.messages).toEqual(['Solo hoy'])
        expect(content.home).toEqual(DEFAULT_SITE_CONTENT.home)
    })

    it('rejects unknown sections with 404', async () => {
        const { service } = setup()
        await expect(service.update('banner', {}, USER)).rejects.toThrow(NotFoundException)
        await expect(service.reset('banner')).rejects.toThrow(NotFoundException)
    })

    it('every default section except Pago Móvil (empty until filled) passes its own DTO', async () => {
        const { service } = setup()
        for (const section of CONTENT_SECTIONS) {
            const save = service.update(
                section,
                structuredClone(DEFAULT_SITE_CONTENT[section]),
                USER,
            )
            if (section === 'payment') await expect(save).rejects.toThrow(BadRequestException)
            else await expect(save).resolves.toMatchObject({ section })
        }
    })

    it('stores the trimmed section as JSON with the author', async () => {
        const { service, entries } = setup()
        await service.update(
            'shipping',
            { ...DEFAULT_SITE_CONTENT.shipping, productionCopy: '  Listo en 2 días  ' },
            USER,
        )
        const [sql, params] = entries.query.mock.calls[0] as [string, unknown[]]
        expect(sql).toContain('ON CONFLICT ("key") DO UPDATE')
        expect(params[0]).toBe('shipping')
        expect(JSON.parse(params[1] as string)).toEqual({
            ...DEFAULT_SITE_CONTENT.shipping,
            productionCopy: 'Listo en 2 días',
        })
        expect(params[2]).toBe(USER.id)
    })

    it('validates formats, money and required fields in Spanish', async () => {
        const { service } = setup()
        const details = await detailsOf(
            service.update(
                'payment',
                {
                    bankCode: '102',
                    bankName: 'Banco de Venezuela',
                    phone: '0212-1234567',
                    idNumber: 'V12345678',
                    holderName: '',
                    instructions: '',
                },
                USER,
            ),
        )
        expect(details).toEqual([
            {
                field: 'bankCode',
                errors: ['El código del banco debe tener el formato 0102 (4 dígitos).'],
            },
            {
                field: 'phone',
                errors: ['El teléfono de Pago Móvil debe tener el formato 0412-5550134.'],
            },
            {
                field: 'idNumber',
                errors: ['Usa V, J o G seguido de 6 a 9 números, por ejemplo V-12345678.'],
            },
            { field: 'holderName', errors: ['El titular es obligatorio.'] },
        ])

        const shipping = await detailsOf(
            service.update(
                'shipping',
                { ...DEFAULT_SITE_CONTENT.shipping, flatRate: -1, freeThreshold: 1.234 },
                USER,
            ),
        )
        expect(shipping).toEqual([
            {
                field: 'freeThreshold',
                errors: ['El monto para envío gratis debe ser un número con hasta 2 decimales.'],
            },
            { field: 'flatRate', errors: ['La tarifa de envío no puede ser negativa.'] },
        ])
    })

    it('accepts cédulas and RIFs', async () => {
        const { service } = setup()
        const payment = {
            bankCode: '0102',
            bankName: 'Banco de Venezuela',
            phone: '0412-5550134',
            idNumber: 'J-123456789',
            holderName: 'KaiZen C.A.',
            instructions: '',
        }
        await expect(service.update('payment', payment, USER)).resolves.toBeDefined()
        await expect(
            service.update('payment', { ...payment, idNumber: 'V-12345678' }, USER),
        ).resolves.toBeDefined()
    })

    it('accepts only V, J or G followed by 6 to 9 digits', async () => {
        const { service } = setup()
        const payment = {
            bankCode: '0102',
            bankName: 'Banco de Venezuela',
            phone: '0412-5550134',
            idNumber: 'V-12345678',
            holderName: 'KaiZen',
            instructions: '',
        }
        for (const idNumber of [
            'E-12345678',
            'P-1234567',
            'V-12345',
            'V-1234567890',
            'v-1234567',
        ]) {
            expect(
                await detailsOf(service.update('payment', { ...payment, idNumber }, USER)),
            ).toEqual([
                {
                    field: 'idNumber',
                    errors: ['Usa V, J o G seguido de 6 a 9 números, por ejemplo V-12345678.'],
                },
            ])
        }
        for (const idNumber of ['V-123456', 'G-20000001', 'J-123456789']) {
            await expect(
                service.update('payment', { ...payment, idNumber }, USER),
            ).resolves.toBeDefined()
        }
    })

    it('refuses a Pago Móvil phone or a WhatsApp on an inactive operator code', async () => {
        const { service, entries } = setup()
        const payment = {
            bankCode: '0104',
            bankName: 'Banco',
            phone: '0426-1234567',
            idNumber: 'V-12345678',
            holderName: 'KaiZen',
            instructions: '',
        }
        expect(await detailsOf(service.update('payment', payment, USER))).toEqual([
            { field: 'bankCode', errors: ['Elige un banco de la lista.'] },
            { field: 'phone', errors: ['El código 0426 no está disponible.'] },
        ])
        expect(
            await detailsOf(
                service.update(
                    'contact',
                    { ...DEFAULT_SITE_CONTENT.contact, whatsapp: '0426-1234567' },
                    USER,
                ),
            ),
        ).toEqual([{ field: 'whatsapp', errors: ['El código 0426 no está disponible.'] }])
        // The contact phone also takes landlines and is not checked against the catalog.
        await expect(
            service.update(
                'contact',
                { ...DEFAULT_SITE_CONTENT.contact, phone: '0426-1234567' },
                USER,
            ),
        ).resolves.toBeDefined()
        expect(entries.query).toHaveBeenCalledTimes(1)
    })

    it('takes the Pago Móvil bank from the active banks of the catalog', async () => {
        const { service, entries, banks } = setup()
        const payment = {
            bankCode: '0102',
            bankName: 'Otro nombre',
            phone: '0412-5550134',
            idNumber: 'V-12345678',
            holderName: 'KaiZen',
            instructions: '',
        }
        await service.update('payment', payment, USER)
        const [, params] = entries.query.mock.calls[0] as [string, unknown[]]
        expect(JSON.parse(params[1] as string)).toMatchObject({
            bankCode: '0102',
            bankName: 'Banco de Venezuela',
        })

        entries.query.mockClear()
        expect(
            await detailsOf(service.update('payment', { ...payment, bankCode: '0104' }, USER)),
        ).toEqual([{ field: 'bankCode', errors: ['Elige un banco de la lista.'] }])
        expect(banks.findActive).toHaveBeenLastCalledWith('0104')
        expect(entries.query).not.toHaveBeenCalled()
    })

    it('checks list sizes and names the offending item', async () => {
        const { service } = setup()
        expect(await detailsOf(service.update('announcements', { messages: [] }, USER))).toEqual([
            {
                field: 'messages',
                errors: ['La lista de anuncios debe tener al menos 1 elemento.'],
            },
        ])
        expect(
            await detailsOf(
                service.update('announcements', { messages: ['Hola', '   ', 'x'] }, USER),
            ),
        ).toEqual([{ field: 'messages', errors: ['El anuncio 2 es obligatorio.'] }])
        const nine = Array.from({ length: 9 }, (_, index) => `Anuncio ${index}`)
        expect(await detailsOf(service.update('announcements', { messages: nine }, USER))).toEqual([
            { field: 'messages', errors: ['La lista de anuncios admite como máximo 8 elementos.'] },
        ])
    })

    it('reports nested list fields by path', async () => {
        const { service } = setup()
        const home = structuredClone(DEFAULT_SITE_CONTENT.home)
        home.steps[1] = { title: '', description: 'Algo' }
        expect(await detailsOf(service.update('home', home, USER))).toEqual([
            { field: 'steps.1.title', errors: ['El título del paso es obligatorio.'] },
        ])
    })

    it('ships no testimonials and stores trimmed ones with optional city and product', async () => {
        expect(DEFAULT_SITE_CONTENT.home.testimonials).toEqual([])
        const { service, entries } = setup()
        await service.update(
            'home',
            {
                ...DEFAULT_SITE_CONTENT.home,
                testimonials: [
                    {
                        quote: '  Me encantó mi perfume  ',
                        name: 'Ana',
                        city: 'Valencia',
                        product: '',
                    },
                    { quote: 'Llegó rapidísimo', name: ' Luis ', city: '', product: 'Khamrah' },
                ],
            },
            USER,
        )
        const [, params] = entries.query.mock.calls[0] as [string, unknown[]]
        expect((JSON.parse(params[1] as string) as { testimonials: unknown }).testimonials).toEqual(
            [
                { quote: 'Me encantó mi perfume', name: 'Ana', city: 'Valencia', product: '' },
                { quote: 'Llegó rapidísimo', name: 'Luis', city: '', product: 'Khamrah' },
            ],
        )
    })

    it('validates each testimonial and the size of the list', async () => {
        const { service } = setup()
        const home = structuredClone(DEFAULT_SITE_CONTENT.home)
        home.testimonials = [
            { quote: '   ', name: 'x'.repeat(61), city: '', product: 'y'.repeat(81) },
        ]
        expect(await detailsOf(service.update('home', home, USER))).toEqual([
            { field: 'testimonials.0.quote', errors: ['La opinión del cliente es obligatoria.'] },
            {
                field: 'testimonials.0.name',
                errors: ['El nombre del cliente no puede superar los 60 caracteres.'],
            },
            {
                field: 'testimonials.0.product',
                errors: ['El producto de la reseña no puede superar los 80 caracteres.'],
            },
        ])

        home.testimonials = [{ quote: 'z'.repeat(401), name: 'Ana', city: '', product: '' }]
        expect(await detailsOf(service.update('home', home, USER))).toEqual([
            {
                field: 'testimonials.0.quote',
                errors: ['La opinión del cliente no puede superar los 400 caracteres.'],
            },
        ])

        home.testimonials = Array.from({ length: 13 }, (_, index) => ({
            quote: `Opinión ${index}`,
            name: 'Ana',
            city: '',
            product: '',
        }))
        expect(await detailsOf(service.update('home', home, USER))).toEqual([
            {
                field: 'testimonials',
                errors: ['La lista de reseñas admite como máximo 12 elementos.'],
            },
        ])

        // Sections are replaced whole: optional fields must still be sent.
        home.testimonials = [{ quote: 'Bien', name: 'Ana' } as never]
        const missing = await detailsOf(service.update('home', home, USER))
        expect(missing.map(({ field, errors }) => [field, errors[0]])).toEqual([
            ['testimonials.0.city', 'La ciudad del cliente debe ser un texto.'],
            ['testimonials.0.product', 'El producto de la reseña debe ser un texto.'],
        ])
    })

    it('only accepts the placeholders and highlight marks each field supports', async () => {
        const { service } = setup()
        expect(
            await detailsOf(
                service.update('announcements', { messages: ['Gratis desde {envio}'] }, USER),
            ),
        ).toEqual([
            {
                field: 'messages',
                errors: [
                    'El anuncio 1 usa {envio}, que no existe. Puedes usar {envioGratis}, {tarifaEnvio}.',
                ],
            },
        ])

        const home = {
            ...DEFAULT_SITE_CONTENT.home,
            heroTitle: 'Perfumes *que hablan por ti',
            heroBadge: 'Hola {marca}',
        }
        expect(await detailsOf(service.update('home', home, USER))).toEqual([
            {
                field: 'heroBadge',
                errors: ['La etiqueta de la portada no admite marcadores como {marca}.'],
            },
            {
                field: 'heroTitle',
                errors: [
                    'El titular de la portada tiene un destacado sin cerrar o vacío. Marca las palabras destacadas así: *palabras*.',
                ],
            },
        ])
    })

    it('rejects unknown fields and unknown About icons', async () => {
        const { service } = setup()
        expect(
            await detailsOf(
                service.update('general', { ...DEFAULT_SITE_CONTENT.general, logo: 'x' }, USER),
            ),
        ).toEqual([{ field: 'logo', errors: ['El campo "logo" no está permitido.'] }])

        const about = structuredClone(DEFAULT_SITE_CONTENT.about)
        ;(about.values[0] as { icon: string }).icon = 'rocket'
        expect(await detailsOf(service.update('about', about, USER))).toEqual([
            { field: 'values.0.icon', errors: ['El ícono del valor no es válido.'] },
        ])
    })

    it('validates the contact handles, phone and email', async () => {
        const { service } = setup()
        const details = await detailsOf(
            service.update(
                'contact',
                {
                    ...DEFAULT_SITE_CONTENT.contact,
                    phone: '+58 412 555 0134',
                    instagram: '@kaizen',
                },
                USER,
            ),
        )
        expect(details.map((detail) => detail.field)).toEqual(['phone', 'instagram'])
        await expect(
            service.update(
                'contact',
                { ...DEFAULT_SITE_CONTENT.contact, phone: '0253-1234567', tiktok: '' },
                USER,
            ),
        ).resolves.toBeDefined()
    })

    it('reset deletes the stored row and returns the defaults', async () => {
        const { service, entries } = setup()
        const section = await service.reset('about')
        expect(entries.delete).toHaveBeenCalledWith({ key: 'about' })
        expect(section).toEqual({
            section: 'about',
            value: DEFAULT_SITE_CONTENT.about,
            isDefault: true,
            updatedAt: null,
            updatedBy: null,
        })
    })

    describe('hero media', () => {
        const video = {
            type: 'video',
            url: `${STORAGE_URL}/hero/clip.mp4`,
            posterUrl: `${STORAGE_URL}/hero/still.jpg`,
            alt: '  Botella sobre la arena  ',
        }

        it('ships none, and stores an uploaded video with its poster and a trimmed alt', async () => {
            expect(DEFAULT_SITE_CONTENT.home.heroMedia).toBeNull()
            const { service, entries } = setup()
            await service.update('home', { ...DEFAULT_SITE_CONTENT.home, heroMedia: video }, USER)
            const [, params] = entries.query.mock.calls[0] as [string, unknown[]]
            expect(JSON.parse(params[1] as string).heroMedia).toEqual({
                ...video,
                alt: 'Botella sobre la arena',
            })
        })

        it('treats a missing hero media as none and drops the poster of an image', async () => {
            const { service, entries } = setup()
            const { heroMedia: _omitted, ...home } = DEFAULT_SITE_CONTENT.home
            await service.update('home', home, USER)
            await service.update(
                'home',
                {
                    ...home,
                    heroMedia: { ...video, type: 'image', url: 'https://cdn.example.com/a.jpg' },
                },
                USER,
            )
            const stored = entries.query.mock.calls.map(
                ([, params]) => JSON.parse((params as unknown[])[1] as string).heroMedia,
            )
            expect(stored[0]).toBeNull()
            expect(stored[1]).toEqual({
                type: 'image',
                url: 'https://cdn.example.com/a.jpg',
                posterUrl: null,
                alt: 'Botella sobre la arena',
            })
        })

        it('accepts only our uploads of the right kind or https URLs', async () => {
            const { service, entries } = setup()
            const save = (heroMedia: unknown) =>
                detailsOf(service.update('home', { ...DEFAULT_SITE_CONTENT.home, heroMedia }, USER))

            expect(
                await save({ ...video, url: 'http://evil.test/a.mp4', posterUrl: 'javascript:x' }),
            ).toEqual([
                {
                    field: 'heroMedia.url',
                    errors: [
                        'El archivo de la portada debe ser un archivo subido o un enlace https://.',
                    ],
                },
                {
                    field: 'heroMedia.posterUrl',
                    errors: [
                        'La imagen previa del video debe ser un archivo subido o un enlace https://.',
                    ],
                },
            ])
            expect(await save({ ...video, posterUrl: `${STORAGE_URL}/hero/other.webm` })).toEqual([
                {
                    field: 'heroMedia.posterUrl',
                    errors: ['La imagen previa del video debe ser una imagen.'],
                },
            ])
            expect(
                (await save({ ...video, type: 'gif', url: '' })).map((detail) => detail.field),
            ).toEqual(['heroMedia.type', 'heroMedia.url'])
            expect((await save('video.mp4')).map((detail) => detail.field)).toEqual(['heroMedia'])
            expect(entries.query).not.toHaveBeenCalled()
        })

        it('deletes the files of a replaced or removed hero media, never foreign URLs', async () => {
            const { service, entries, storage } = setup()
            entries.findOne.mockResolvedValueOnce({
                key: 'home',
                value: { ...DEFAULT_SITE_CONTENT.home, heroMedia: video },
            })
            await service.update(
                'home',
                {
                    ...DEFAULT_SITE_CONTENT.home,
                    heroMedia: { ...video, url: `${STORAGE_URL}/hero/new.webm` },
                },
                USER,
            )
            // The poster is kept, so only the old video goes.
            expect(storage.deleteMedia).toHaveBeenCalledTimes(1)
            expect(storage.deleteMedia).toHaveBeenCalledWith({
                publicId: 'hero/clip.mp4',
                kind: 'video',
            })

            storage.deleteMedia.mockClear()
            entries.findOne.mockResolvedValueOnce({
                key: 'home',
                value: {
                    heroMedia: { ...video, posterUrl: 'https://cdn.example.com/poster.jpg' },
                },
            })
            await service.reset('home')
            expect(storage.deleteMedia).toHaveBeenCalledTimes(1)
            expect(storage.deleteMedia).toHaveBeenCalledWith({
                publicId: 'hero/clip.mp4',
                kind: 'video',
            })
        })

        it('falls back to none for a malformed stored hero media', () => {
            expect(
                mergeSection('home', { heroMedia: { type: 'gif', url: 'x' } }).heroMedia,
            ).toBeNull()
            expect(
                mergeSection('home', { heroMedia: { type: 'image', url: 'https://a.test/x.jpg' } })
                    .heroMedia,
            ).toEqual({ type: 'image', url: 'https://a.test/x.jpg', posterUrl: null, alt: '' })
        })

        it('uploads a checked video and poster and returns their URLs', async () => {
            const { service, storage } = setup()
            const result = await service.uploadHeroMedia(
                multerFile(MP4_BYTES),
                multerFile(PNG_BYTES),
            )
            expect(storage.uploadMedia.mock.calls.map(([media]) => media.type)).toEqual([
                'mp4',
                'png',
            ])
            expect(result).toEqual({
                url: `${STORAGE_URL}/hero/file-1.mp4`,
                publicId: 'hero/file-1.mp4',
                type: 'video',
                posterUrl: `${STORAGE_URL}/hero/file-2.png`,
            })
        })

        it('rejects missing, disguised or oversized files before storing anything', async () => {
            const { service, storage } = setup()
            await expect(service.uploadHeroMedia(undefined, undefined)).rejects.toThrow(
                BadRequestException,
            )
            await expect(
                service.uploadHeroMedia(multerFile(Buffer.from('<svg/>')), undefined),
            ).rejects.toThrow('La portada debe ser una imagen JPG, PNG, WEBP o AVIF')
            await expect(
                service.uploadHeroMedia(multerFile(PNG_BYTES), multerFile(MP4_BYTES)),
            ).rejects.toThrow('La imagen previa debe ser una imagen')
            await expect(
                service.uploadHeroMedia(multerFile(PNG_BYTES, 6 * 1024 * 1024), undefined),
            ).rejects.toThrow('Las imágenes pueden pesar como máximo 5 MB.')
            expect(storage.uploadMedia).not.toHaveBeenCalled()
        })
    })
})
