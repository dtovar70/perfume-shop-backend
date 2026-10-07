import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    PayloadTooLargeException,
    type ValidationPipe,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { CACHE_KEYS } from '../cache/cache-keys.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { BanksService } from '../catalogs/banks.service.js'
import { MobilePrefixesService } from '../catalogs/mobile-prefixes.service.js'
import { createValidationPipe } from '../common/pipes/validation.pipe.js'
import type { AuthUser } from '../common/types/auth-user.js'
import { detectMediaType, mediaKind, type MediaType } from '../storage/media-type.js'
import {
    STORAGE_SERVICE,
    type StorageService,
    type StoredMediaRef,
} from '../storage/storage.service.js'
import { DEFAULT_SITE_CONTENT } from './content.defaults.js'
import {
    CONTENT_SECTIONS,
    HERO_MEDIA_TYPES,
    isContentSection,
    type ContactContent,
    type ContentSection,
    type HeroMedia,
    type HomeContent,
    type PaymentContent,
    type SiteContent,
} from './content.types.js'
import { CONTENT_SECTION_DTOS } from './dto/index.js'
import {
    HERO_IMAGE_TOO_LARGE,
    HERO_MEDIA_FIELD,
    INVALID_HERO_MEDIA_TYPE,
    INVALID_HERO_POSTER_TYPE,
    MAX_HERO_IMAGE_BYTES,
} from './hero-media-upload.js'
import { SiteContentEntry } from './entities/site-content.entity.js'

export function unknownSectionMessage(section: string): string {
    return `No existe la sección de contenido «${section}».`
}

/** One section as the admin sees it. Matches `AdminContentSection` in the front. */
export interface AdminContentSectionDto<K extends ContentSection = ContentSection> {
    section: K
    value: SiteContent[K]
    /** True when nothing is stored and the built-in texts are shown. */
    isDefault: boolean
    /** ISO 8601, null for defaults. */
    updatedAt: string | null
    updatedBy: { id: string; name: string } | null
}

/** An uploaded hero file. Saving the home section with its URL is what publishes it. */
export interface HeroMediaUploadDto {
    url: string
    /** Storage key of the file. */
    publicId: string
    type: HeroMedia['type']
    /** The uploaded `poster` image, if one was sent. */
    posterUrl: string | null
}

export type AdminContentDto = { [K in ContentSection]: AdminContentSectionDto<K> }

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameKind(stored: unknown, fallback: unknown): boolean {
    if (Array.isArray(fallback)) return Array.isArray(stored)
    return typeof stored === typeof fallback && stored !== null
}

/** A stored hero media with the expected shape, or null (older or hand-edited rows). */
export function sanitizeHeroMedia(value: unknown): HeroMedia | null {
    if (!isPlainObject(value)) return null
    const { type, url, posterUrl, alt } = value
    if (!(HERO_MEDIA_TYPES as readonly unknown[]).includes(type)) return null
    if (typeof url !== 'string' || url === '') return null
    return {
        type: type as HeroMedia['type'],
        url,
        posterUrl: typeof posterUrl === 'string' && posterUrl !== '' ? posterUrl : null,
        alt: typeof alt === 'string' ? alt : '',
    }
}

/** URLs of the files a hero media points at (the media itself and its poster). */
function heroMediaUrls(media: HeroMedia | null | undefined): string[] {
    if (!media) return []
    return media.posterUrl ? [media.url, media.posterUrl] : [media.url]
}

/**
 * Stored values over the defaults, field by field. Unknown fields are dropped and fields of the
 * wrong kind fall back to the default, so an older or hand-edited row can never break the site.
 */
export function mergeSection<K extends ContentSection>(
    section: K,
    stored: unknown,
): SiteContent[K] {
    const defaults = DEFAULT_SITE_CONTENT[section]
    if (!isPlainObject(stored)) return structuredClone(defaults)

    const merged = structuredClone(defaults) as unknown as Record<string, unknown>
    for (const [field, fallback] of Object.entries(defaults)) {
        const value = stored[field]
        if (value !== undefined && sameKind(value, fallback)) merged[field] = value
    }
    if (section === 'home') merged.heroMedia = sanitizeHeroMedia(stored.heroMedia)
    return merged as unknown as SiteContent[K]
}

@Injectable()
export class ContentService {
    private readonly logger = new Logger(ContentService.name)
    /** Same rules and Spanish error format as the global pipe, applied to the section's DTO. */
    private readonly validation: ValidationPipe = createValidationPipe()

    constructor(
        @InjectRepository(SiteContentEntry)
        private readonly entries: Repository<SiteContentEntry>,
        private readonly banks: BanksService,
        private readonly mobilePrefixes: MobilePrefixesService,
        @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
        private readonly cache: MemoryCache,
    ) {}

    /**
     * Every section, stored values merged over the defaults. Cached: every page, checkout and
     * email reads it; the admin routes invalidate it (`@InvalidatesCache('content')`).
     */
    getAll(): Promise<SiteContent> {
        return this.cache.getOrSet(CACHE_KEYS.content(), () => this.loadAll())
    }

    private async loadAll(): Promise<SiteContent> {
        const rows = await this.entries.find()
        const stored = new Map(rows.map((row) => [row.key, row.value]))
        return Object.fromEntries(
            CONTENT_SECTIONS.map((section) => [
                section,
                mergeSection(section, stored.get(section)),
            ]),
        ) as unknown as SiteContent
    }

    async getAllForAdmin(): Promise<AdminContentDto> {
        const rows = await this.entries.find({ relations: { updatedBy: true } })
        const bySection = new Map(rows.map((row) => [row.key, row]))
        return Object.fromEntries(
            CONTENT_SECTIONS.map((section) => [
                section,
                toAdminSection(section, bySection.get(section)),
            ]),
        ) as unknown as AdminContentDto
    }

    /** Replaces a whole section. `body` is validated against the section's DTO. */
    async update(section: string, body: unknown, user: AuthUser): Promise<AdminContentSectionDto> {
        const key = this.assertSection(section)
        const dto: object = await this.validation.transform(body, {
            type: 'body',
            metatype: CONTENT_SECTION_DTOS[key],
        })
        await this.checkCatalogFields(key, dto)
        const previousHeroMedia = key === 'home' ? await this.storedHeroMedia() : null

        // One atomic upsert: two admins saving at once can never collide on the primary key.
        await this.entries.query(
            `INSERT INTO "site_content" ("key", "value", "updated_at", "updated_by")
             VALUES ($1, $2::jsonb, now(), $3)
             ON CONFLICT ("key") DO UPDATE
             SET "value" = EXCLUDED."value", "updated_at" = now(), "updated_by" = EXCLUDED."updated_by"`,
            [key, JSON.stringify(dto), user.id],
        )
        const saved = await this.entries.findOne({
            where: { key },
            relations: { updatedBy: true },
        })
        if (key === 'home') {
            await this.deleteUnusedHeroFiles(previousHeroMedia, (dto as HomeContent).heroMedia)
        }
        return toAdminSection(key, saved ?? undefined)
    }

    /** Drops the stored value, so the section shows the built-in texts again. */
    async reset(section: string): Promise<AdminContentSectionDto> {
        const key = this.assertSection(section)
        const previousHeroMedia = key === 'home' ? await this.storedHeroMedia() : null
        await this.entries.delete({ key })
        if (key === 'home') await this.deleteUnusedHeroFiles(previousHeroMedia, null)
        return toAdminSection(key, undefined)
    }

    /**
     * Stores the hero media (and its optional poster) after checking the real file type.
     * Nothing is published until the home section is saved with the returned URL.
     */
    async uploadHeroMedia(
        file: Express.Multer.File | undefined,
        poster: Express.Multer.File | undefined,
    ): Promise<HeroMediaUploadDto> {
        if (!file) {
            throw new BadRequestException(
                `Adjunta la imagen o el video en el campo "${HERO_MEDIA_FIELD}".`,
            )
        }
        const type = checkedMediaType(file, INVALID_HERO_MEDIA_TYPE)
        const posterType = poster ? checkedMediaType(poster, INVALID_HERO_POSTER_TYPE) : null
        if (posterType && mediaKind(posterType) !== 'image') {
            throw new BadRequestException(INVALID_HERO_POSTER_TYPE)
        }

        const stored: StoredMediaRef[] = []
        try {
            const media = await this.storage.uploadMedia({ buffer: file.buffer, type }, 'hero')
            stored.push({ publicId: media.publicId, kind: mediaKind(type) })
            const posterFile =
                poster && posterType
                    ? await this.storage.uploadMedia(
                          { buffer: poster.buffer, type: posterType },
                          'hero',
                      )
                    : null
            return {
                url: media.url,
                publicId: media.publicId,
                type: mediaKind(type),
                posterUrl: posterFile?.url ?? null,
            }
        } catch (error) {
            for (const ref of stored) await this.deleteHeroFile(ref)
            this.logger.error('Hero media upload failed', error as Error)
            throw new BadRequestException('No pudimos guardar el archivo. Intenta de nuevo.')
        }
    }

    /** The hero media currently saved, before a change replaces it. */
    private async storedHeroMedia(): Promise<HeroMedia | null> {
        const row = await this.entries.findOne({ where: { key: 'home' } })
        return isPlainObject(row?.value) ? sanitizeHeroMedia(row.value.heroMedia) : null
    }

    /**
     * Deletes the uploaded files the previous hero media used and the new one no longer does
     * (replaced or removed). URLs we did not upload are left alone; a failure only leaves an
     * orphan file.
     */
    private async deleteUnusedHeroFiles(
        previous: HeroMedia | null,
        next: HeroMedia | null,
    ): Promise<void> {
        const kept = new Set(heroMediaUrls(next))
        for (const url of heroMediaUrls(previous)) {
            if (kept.has(url)) continue
            const stored = this.storage.mediaFromUrl(url, 'hero')
            if (stored) await this.deleteHeroFile(stored)
        }
    }

    private async deleteHeroFile(stored: StoredMediaRef): Promise<void> {
        await this.storage.deleteMedia(stored).catch((error: unknown) => {
            this.logger.warn(`Could not delete hero media "${stored.publicId}": ${String(error)}`)
        })
    }

    /**
     * Fields that must match a catalog, after the DTO: the Pago Móvil bank must be an active bank
     * of `banks` (its name is taken from the catalog, so the details the customer copies always
     * match the bank list), and the Pago Móvil phone and the contact WhatsApp need an active
     * operator code of `mobile_prefixes`. All problems are reported together.
     */
    private async checkCatalogFields(section: ContentSection, dto: object): Promise<void> {
        const details: { field: string; errors: string[] }[] = []
        const checkPhone = async (field: string, phone: string) => {
            const problem = await this.mobilePrefixes.phoneProblem(phone)
            if (problem) details.push({ field, errors: [problem] })
        }

        if (section === 'payment') {
            const payment = dto as PaymentContent
            const bank = await this.banks.findActive(payment.bankCode)
            if (bank) payment.bankName = bank.name
            else details.push({ field: 'bankCode', errors: ['Elige un banco de la lista.'] })
            await checkPhone('phone', payment.phone)
        }
        if (section === 'contact') await checkPhone('whatsapp', (dto as ContactContent).whatsapp)
        if (section === 'home') details.push(...this.heroMediaProblems(dto as HomeContent))

        if (details.length) {
            throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                message: 'Los datos enviados no son válidos. Revisa los campos marcados.',
                details,
            })
        }
    }

    /**
     * The hero media must point at one of our uploads (of the declared kind) or at an https URL.
     * Normalizes the optional parts: a missing media is null, an image has no poster.
     */
    private heroMediaProblems(home: HomeContent): { field: string; errors: string[] }[] {
        home.heroMedia ??= null
        const media = home.heroMedia
        if (!media) return []
        if (media.type === 'image') media.posterUrl = null
        media.posterUrl ??= null

        const problems: { field: string; errors: string[] }[] = []
        const check = (field: string, url: string, kind: HeroMedia['type'], label: string) => {
            const stored = this.storage.mediaFromUrl(url, 'hero')
            if (stored) {
                if (stored.kind !== kind) {
                    problems.push({
                        field,
                        errors: [
                            kind === 'video'
                                ? `${label} debe ser un video.`
                                : `${label} debe ser una imagen.`,
                        ],
                    })
                }
                return
            }
            if (!isHttpsUrl(url)) {
                problems.push({
                    field,
                    errors: [`${label} debe ser un archivo subido o un enlace https://.`],
                })
            }
        }
        check('heroMedia.url', media.url, media.type, 'El archivo de la portada')
        if (media.posterUrl) {
            check('heroMedia.posterUrl', media.posterUrl, 'image', 'La imagen previa del video')
        }
        return problems
    }

    private assertSection(section: string): ContentSection {
        if (!isContentSection(section)) throw new NotFoundException(unknownSectionMessage(section))
        return section
    }
}

/** The real type of an uploaded hero file; images are held to their own, smaller limit. */
function checkedMediaType(file: Express.Multer.File, invalidMessage: string): MediaType {
    const type = detectMediaType(file.buffer)
    if (!type) throw new BadRequestException(invalidMessage)
    if (mediaKind(type) === 'image' && file.size > MAX_HERO_IMAGE_BYTES) {
        throw new PayloadTooLargeException(HERO_IMAGE_TOO_LARGE)
    }
    return type
}

function isHttpsUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && url.hostname !== ''
    } catch {
        return false
    }
}

function toAdminSection<K extends ContentSection>(
    section: K,
    row: SiteContentEntry | undefined,
): AdminContentSectionDto<K> {
    return {
        section,
        value: mergeSection(section, row?.value),
        isDefault: row === undefined,
        updatedAt: row ? row.updatedAt.toISOString() : null,
        updatedBy: row?.updatedBy ? { id: row.updatedBy.id, name: row.updatedBy.name } : null,
    }
}
