import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { mobilePrefixOf } from '../common/validation/ve-formats.js'
import { DEFAULT_SITE_CONTENT } from '../content/content.defaults.js'
import { isDbError } from '../database/db-errors.js'
import { FINISHED_STATUSES } from '../orders/order-status.js'
import type { CreateMobilePrefixDto } from './dto/create-mobile-prefix.dto.js'
import type { UpdateMobilePrefixDto } from './dto/update-mobile-prefix.dto.js'
import { MobilePrefix } from './entities/mobile-prefix.entity.js'

export const MOBILE_PREFIX_NOT_FOUND = 'No encontramos ese código de celular.'
export const MOBILE_PREFIX_ORDER_MISMATCH =
    'La lista debe incluir exactamente todos los códigos, cada uno una sola vez.'
/** Sub-route of `admin/catalogs/mobile-prefixes` used to reorder (never a code: codes are digits). */
export const MOBILE_PREFIX_ORDER_ROUTE = 'order'
/**
 * How long the active codes are kept in memory. Edits made through this instance clear the
 * cache at once; with several instances the others follow within this time.
 */
export const MOBILE_PREFIX_CACHE_MS = 60_000

/**
 * Content fields checked against this catalog; "in use" when their value starts with the code.
 * The contact "Teléfono" also takes landlines and is not checked, so it never blocks a delete.
 */
export const CONTENT_PHONE_FIELDS = ['payment.phone', 'contact.whatsapp'] as const
export type ContentPhoneField = (typeof CONTENT_PHONE_FIELDS)[number]

const CONTENT_FIELD_REASONS: Record<ContentPhoneField, string> = {
    'payment.phone': 'es el teléfono de tu Pago Móvil',
    'contact.whatsapp': 'es el WhatsApp de contacto',
}

/** Matches `MobilePrefix` in frontend-perfume-shop/src/@types/catalog.ts. */
export interface MobilePrefixDto {
    code: string
}

/** Matches `AdminMobilePrefix` in frontend-perfume-shop/src/@types/catalog.ts. */
export interface AdminMobilePrefixDto extends MobilePrefixDto {
    isActive: boolean
    sortOrder: number
    /** Orders still in progress (not delivered, cancelled or expired) with a phone on this code. */
    activeOrderCount: number
    /** Store content (as the site shows it, defaults included) with a phone on this code. */
    contentFields: ContentPhoneField[]
}

interface MobilePrefixUsage {
    activeOrderCount: number
    contentFields: ContentPhoneField[]
}

export function unavailablePrefixMessage(code: string): string {
    return `El código ${code} no está disponible.`
}

function codeTakenMessage(code: string): string {
    return `Ya existe el código ${code}.`
}

function joinReasons(reasons: string[]): string {
    if (reasons.length <= 1) return reasons.join('')
    return `${reasons.slice(0, -1).join(', ')} y ${reasons.at(-1)}`
}

/** Why a code cannot be deleted, or null when nothing in progress uses it. */
export function mobilePrefixInUseMessage(code: string, usage: MobilePrefixUsage): string | null {
    const reasons = [
        usage.activeOrderCount === 1
            ? 'lo usa 1 pedido en curso'
            : usage.activeOrderCount > 1
              ? `lo usan ${usage.activeOrderCount} pedidos en curso`
              : '',
        ...usage.contentFields.map((field) => CONTENT_FIELD_REASONS[field]),
    ].filter(Boolean)
    if (!reasons.length) return null
    return `No puedes eliminar el código ${code} porque ${joinReasons(reasons)}. Desactívalo para ocultarlo.`
}

function byOrder(a: MobilePrefix, b: MobilePrefix): number {
    return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)
}

/**
 * The operator code of every phone of an order in progress (the checkout phone and the payment
 * proofs), counted once per order. Older free-form phones are reduced to their digits, so
 * "+58 424 123 4567" still counts for 0424.
 */
const ACTIVE_ORDER_USAGE_SQL = `
    WITH "phones" AS (
        SELECT o."id" AS "order_id", o."customer_phone" AS "phone"
        FROM "orders" o
        WHERE o."status" <> ALL($1::varchar[])
        UNION ALL
        SELECT o."id", p."payer_phone"
        FROM "order_payments" p
        JOIN "orders" o ON o."id" = p."order_id"
        WHERE o."status" <> ALL($1::varchar[])
    ), "digits" AS (
        SELECT "order_id", regexp_replace(regexp_replace("phone", '\\D', '', 'g'), '^00', '') AS "d"
        FROM "phones"
    )
    SELECT CASE WHEN "d" ~ '^58[0-9]{10}$' THEN '0' || substr("d", 3, 3) ELSE left("d", 4) END
               AS "code",
           COUNT(DISTINCT "order_id") AS "count"
    FROM "digits"
    GROUP BY 1`

/**
 * Venezuelan mobile operator codes (`mobile_prefixes`): public list, admin CRUD and the check
 * every mobile phone field runs before saving. The rows are cached in memory.
 */
@Injectable()
export class MobilePrefixesService {
    private cache: { rows: MobilePrefix[]; expiresAt: number } | null = null

    constructor(
        @InjectRepository(MobilePrefix) private readonly prefixes: Repository<MobilePrefix>,
    ) {}

    /** Active codes, in select order. */
    async listActive(): Promise<MobilePrefixDto[]> {
        const rows = await this.rows()
        return rows.filter((row) => row.isActive).map((row) => ({ code: row.code }))
    }

    /** Every code, inactive ones included, with what references it. */
    async listForAdmin(): Promise<AdminMobilePrefixDto[]> {
        const [rows, usage] = await Promise.all([this.prefixes.find(), this.usage()])
        return rows.sort(byOrder).map((row) => toAdminDto(row, usage(row.code)))
    }

    /**
     * Null when the operator code of `phone` (already "0424-1234567"-shaped) is active, otherwise
     * the Spanish message for the field: "El código 0426 no está disponible."
     */
    async phoneProblem(phone: string): Promise<string | null> {
        const code = mobilePrefixOf(phone)
        const rows = await this.rows()
        return rows.some((row) => row.code === code && row.isActive)
            ? null
            : unavailablePrefixMessage(code)
    }

    async create(dto: CreateMobilePrefixDto): Promise<AdminMobilePrefixDto> {
        if (await this.prefixes.existsBy({ code: dto.code })) {
            throw new ConflictException(codeTakenMessage(dto.code))
        }
        const prefix: MobilePrefix = {
            code: dto.code,
            isActive: dto.isActive ?? true,
            sortOrder: await this.nextSortOrder(),
        }
        try {
            await this.prefixes.insert(prefix)
        } catch (error) {
            if (isDbError(error, '23505')) throw new ConflictException(codeTakenMessage(dto.code))
            throw error
        } finally {
            this.cache = null
        }
        const usage = await this.usage()
        return toAdminDto(prefix, usage(prefix.code))
    }

    async update(code: string, dto: UpdateMobilePrefixDto): Promise<AdminMobilePrefixDto> {
        const prefix = await this.prefixes.findOneBy({ code })
        if (!prefix) throw new NotFoundException(MOBILE_PREFIX_NOT_FOUND)
        await this.prefixes.update({ code }, { isActive: dto.isActive })
        this.cache = null
        const usage = await this.usage()
        return toAdminDto({ ...prefix, isActive: dto.isActive }, usage(code))
    }

    /** Rewrites every position as 0..n-1 following `codes` (exactly the existing codes). */
    async reorder(codes: string[]): Promise<AdminMobilePrefixDto[]> {
        await this.prefixes.manager.transaction(async (manager) => {
            const current = await manager.find(MobilePrefix, { select: { code: true } })
            const currentCodes = new Set(current.map((row) => row.code))
            const sameSet =
                currentCodes.size === codes.length &&
                new Set(codes).size === codes.length &&
                codes.every((code) => currentCodes.has(code))
            if (!sameSet) throw new BadRequestException(MOBILE_PREFIX_ORDER_MISMATCH)

            for (const [index, code] of codes.entries()) {
                await manager.update(MobilePrefix, { code }, { sortOrder: index })
            }
        })
        this.cache = null
        return this.listForAdmin()
    }

    /**
     * Phones are text (no foreign key), so deleting a code never touches stored data. It is
     * refused while an order in progress or the store content uses it, because those phones may
     * still be edited or re-sent; deactivate it instead. Finished orders do not count.
     */
    async remove(code: string): Promise<void> {
        if (!(await this.prefixes.existsBy({ code }))) {
            throw new NotFoundException(MOBILE_PREFIX_NOT_FOUND)
        }
        const usage = await this.usage()
        const message = mobilePrefixInUseMessage(code, usage(code))
        if (message) throw new ConflictException(message)
        await this.prefixes.delete({ code })
        this.cache = null
    }

    /** Rows in select order, from the cache while it is fresh. */
    private async rows(): Promise<MobilePrefix[]> {
        if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.rows
        const rows = (await this.prefixes.find()).sort(byOrder)
        this.cache = { rows, expiresAt: Date.now() + MOBILE_PREFIX_CACHE_MS }
        return rows
    }

    /** Orders in progress per code and the content fields on each code. */
    private async usage(): Promise<(code: string) => MobilePrefixUsage> {
        const [orders, content] = await Promise.all([
            this.prefixes.query<{ code: string; count: string }[]>(ACTIVE_ORDER_USAGE_SQL, [
                FINISHED_STATUSES,
            ]),
            this.prefixes.query<{ key: string; value: unknown }[]>(
                `SELECT "key", "value" FROM "site_content" WHERE "key" IN ('payment', 'contact')`,
            ),
        ])
        const counts = new Map(orders.map((row) => [row.code, Number(row.count)]))
        const phones = contentPhones(content)
        return (code) => ({
            activeOrderCount: counts.get(code) ?? 0,
            contentFields: CONTENT_PHONE_FIELDS.filter(
                (field) => mobilePrefixOf(phones[field]) === code,
            ),
        })
    }

    private async nextSortOrder(): Promise<number> {
        const row = await this.prefixes
            .createQueryBuilder('prefix')
            .select('MAX(prefix.sortOrder)', 'max')
            .getRawOne<{ max: number | null }>()
        return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1
    }
}

/**
 * The phones the site shows: the stored value of each field when it is a string, otherwise the
 * built-in default (the same rule as `mergeSection` in the content service).
 */
function contentPhones(rows: { key: string; value: unknown }[]): Record<ContentPhoneField, string> {
    const stored = new Map(rows.map((row) => [row.key, row.value]))
    const pick = (section: 'payment' | 'contact', field: string): string => {
        const value = (stored.get(section) as Record<string, unknown> | undefined)?.[field]
        const fallback = (DEFAULT_SITE_CONTENT[section] as unknown as Record<string, string>)[field]
        return typeof value === 'string' ? value : (fallback ?? '')
    }
    return {
        'payment.phone': pick('payment', 'phone'),
        'contact.whatsapp': pick('contact', 'whatsapp'),
    }
}

function toAdminDto(prefix: MobilePrefix, usage: MobilePrefixUsage): AdminMobilePrefixDto {
    return {
        code: prefix.code,
        isActive: prefix.isActive,
        sortOrder: prefix.sortOrder,
        ...usage,
    }
}
