import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    type OnApplicationBootstrap,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import { omitUndefined } from '../database/db-errors.js'
import { ORDER_STATUSES, type OrderStatus } from '../orders/order-status.js'
import { whatsAppTemplateError } from '../orders/whatsapp/whatsapp-template.js'
import type { BadgeTone } from './badge-tones.js'
import type { UpdateOrderStatusGroupDto } from './dto/update-order-status-group.dto.js'
import type { UpdateOrderStatusDto } from './dto/update-order-status.dto.js'
import { OrderStatusDefinition } from './entities/order-status-definition.entity.js'
import { OrderStatusGroup } from './entities/order-status-group.entity.js'

export const ORDER_STATUS_NOT_FOUND = 'No encontramos ese estado de pedido.'
export const ORDER_STATUS_GROUP_NOT_FOUND = 'No encontramos esa pestaña de pedidos.'

/** Matches `OrderStatusInfo` in frontend-perfume-shop/src/@types/catalog.ts. */
export interface OrderStatusDto {
    code: string
    label: string
    customerLabel: string
    customerTitle: string | null
    customerDescription: string | null
    groupCode: string
    tone: BadgeTone
    sortOrder: number
    isTerminal: boolean
}

/** Admin view of a status: also the WhatsApp message template (never sent to the public). */
export interface AdminOrderStatusDto extends OrderStatusDto {
    whatsappTemplate: string
}

/** Matches `OrderStatusGroupInfo` in frontend-perfume-shop/src/@types/catalog.ts. */
export interface OrderStatusGroupDto {
    code: string
    label: string
    description: string | null
    sortOrder: number
    highlight: boolean
    /** Codes of its statuses, in status order. */
    statuses: string[]
}

/** `GET /catalogs/order-statuses`: both lists sorted by `sortOrder`. */
export interface OrderStatusCatalogDto {
    groups: OrderStatusGroupDto[]
    statuses: OrderStatusDto[]
}

/** `GET /admin/catalogs/order-statuses`: the public catalog plus the WhatsApp templates. */
export interface AdminOrderStatusCatalogDto {
    groups: OrderStatusGroupDto[]
    statuses: AdminOrderStatusDto[]
}

/** Label of a status code; never throws (unknown codes are prettified). */
export type StatusLabeler = (code: OrderStatus) => string

/** "PENDIENTE_VERIFICACION" -> "Pendiente verificacion": the last resort when a row is missing. */
export function prettifyStatusCode(code: string): string {
    const words = code.toLowerCase().split('_').filter(Boolean).join(' ')
    return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Codes missing from the table and codes the table has but the code does not know. Both lists
 * empty means the catalog matches `ORDER_STATUSES`.
 */
export function diffStatusCodes(
    tableCodes: readonly string[],
    expected: readonly string[] = ORDER_STATUSES,
): { missing: string[]; unknown: string[] } {
    const inTable = new Set(tableCodes)
    const known = new Set(expected)
    return {
        missing: expected.filter((code) => !inTable.has(code)),
        unknown: tableCodes.filter((code) => !known.has(code)),
    }
}

function byOrder<T extends { sortOrder: number; code: string }>(a: T, b: T): number {
    return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)
}

function toStatusDto(row: OrderStatusDefinition): AdminOrderStatusDto {
    return {
        code: row.code,
        label: row.label,
        customerLabel: row.customerLabel,
        customerTitle: row.customerTitle,
        customerDescription: row.customerDescription,
        groupCode: row.groupCode,
        tone: row.tone,
        sortOrder: row.sortOrder,
        isTerminal: row.isTerminal,
        whatsappTemplate: row.whatsappTemplate,
    }
}

function toPublicStatus({
    whatsappTemplate: _template,
    ...status
}: AdminOrderStatusDto): OrderStatusDto {
    return status
}

/** "" clears an optional text. */
function emptyToNull(value: string | null | undefined): string | null | undefined {
    return value === '' ? null : value
}

/**
 * The order status catalog (labels, customer copy, badge tones and the admin tabs), kept in
 * memory: it is read on every order response and changes only through the admin endpoints of
 * this service, which drop the cached copy. With several API instances an edit reaches the
 * others on their next restart.
 *
 * At startup it checks that the table holds exactly the codes of `ORDER_STATUSES`: a missing
 * seed or a code added only on one side fails fast outside production and is logged in it.
 */
@Injectable()
export class OrderStatusCatalogService implements OnApplicationBootstrap {
    private readonly logger = new Logger(OrderStatusCatalogService.name)
    private cached: Promise<AdminOrderStatusCatalogDto> | null = null

    constructor(
        @InjectRepository(OrderStatusDefinition)
        private readonly statuses: Repository<OrderStatusDefinition>,
        @InjectRepository(OrderStatusGroup)
        private readonly groups: Repository<OrderStatusGroup>,
        private readonly config: ConfigService<Env, true>,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.verifyCodes()
    }

    /** Compares the table with `ORDER_STATUSES`; throws outside production when they differ. */
    async verifyCodes(): Promise<void> {
        const rows = await this.statuses.find({ select: { code: true } })
        const { missing, unknown } = diffStatusCodes(rows.map((row) => row.code))
        if (!missing.length && !unknown.length) return

        const problems = [
            missing.length ? `missing in order_statuses: ${missing.join(', ')}` : '',
            unknown.length ? `unknown to the code (ORDER_STATUSES): ${unknown.join(', ')}` : '',
        ].filter(Boolean)
        const message =
            `The order status catalog does not match ORDER_STATUSES (${problems.join('; ')}). ` +
            'Run the pending migrations (npm run db:migrate) or add the status to both sides.'
        this.logger.error(message)
        if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
            throw new Error(message)
        }
    }

    /** Groups and statuses, sorted, without the admin-only fields (public endpoint). */
    async getCatalog(): Promise<OrderStatusCatalogDto> {
        const catalog = await this.getAdminCatalog()
        return { groups: catalog.groups, statuses: catalog.statuses.map(toPublicStatus) }
    }

    /** The whole catalog. Loaded once and reused until an admin edit. */
    getAdminCatalog(): Promise<AdminOrderStatusCatalogDto> {
        if (!this.cached) {
            const loading = this.load()
            this.cached = loading
            // A failed load is not cached: the next call retries.
            loading.catch(() => {
                if (this.cached === loading) this.cached = null
            })
        }
        return this.cached
    }

    /** Admin labels by code, for the order responses (`statusLabel`, history, transitions). */
    async labeler(): Promise<StatusLabeler> {
        const catalog = await this.getCatalog()
        const labels = new Map(catalog.statuses.map((status) => [status.code, status.label]))
        return (code) => labels.get(code) ?? prettifyStatusCode(code)
    }

    /** The WhatsApp message template of a status ("" when the row is missing). */
    async whatsappTemplate(code: OrderStatus): Promise<string> {
        const catalog = await this.getAdminCatalog()
        return catalog.statuses.find((status) => status.code === code)?.whatsappTemplate ?? ''
    }

    async updateStatus(
        code: string,
        dto: UpdateOrderStatusDto,
    ): Promise<AdminOrderStatusCatalogDto> {
        const exists = await this.statuses.existsBy({ code })
        if (!exists) throw new NotFoundException(ORDER_STATUS_NOT_FOUND)
        // The DTO checked the placeholders; `{comprobante}` also depends on the status.
        const templateError =
            dto.whatsappTemplate === undefined
                ? null
                : whatsAppTemplateError(dto.whatsappTemplate, code as OrderStatus)
        if (templateError) {
            throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                message: 'Los datos enviados no son válidos. Revisa los campos marcados.',
                details: [{ field: 'whatsappTemplate', errors: [templateError] }],
            })
        }

        const changes = omitUndefined({
            label: dto.label,
            customerLabel: dto.customerLabel,
            customerTitle: emptyToNull(dto.customerTitle),
            customerDescription: emptyToNull(dto.customerDescription),
            tone: dto.tone,
            whatsappTemplate: dto.whatsappTemplate,
        })
        await this.save(() => this.statuses.update({ code }, changes), changes)
        return this.getAdminCatalog()
    }

    async updateGroup(
        code: string,
        dto: UpdateOrderStatusGroupDto,
    ): Promise<AdminOrderStatusCatalogDto> {
        const exists = await this.groups.existsBy({ code })
        if (!exists) throw new NotFoundException(ORDER_STATUS_GROUP_NOT_FOUND)

        const changes = omitUndefined({
            label: dto.label,
            description: emptyToNull(dto.description),
            sortOrder: dto.sortOrder,
        })
        await this.save(() => this.groups.update({ code }, changes), changes)
        return this.getAdminCatalog()
    }

    private async save(write: () => Promise<unknown>, changes: object): Promise<void> {
        if (!Object.keys(changes).length) {
            throw new BadRequestException('No enviaste ningún cambio.')
        }
        try {
            await write()
        } finally {
            this.cached = null
        }
    }

    private async load(): Promise<AdminOrderStatusCatalogDto> {
        const [groups, statuses] = await Promise.all([this.groups.find(), this.statuses.find()])
        const sortedStatuses = [...statuses].sort(byOrder).map(toStatusDto)
        return {
            groups: [...groups].sort(byOrder).map((group) => ({
                code: group.code,
                label: group.label,
                description: group.description,
                sortOrder: group.sortOrder,
                highlight: group.highlight,
                statuses: sortedStatuses
                    .filter((status) => status.groupCode === group.code)
                    .map((status) => status.code),
            })),
            statuses: sortedStatuses,
        }
    }
}
