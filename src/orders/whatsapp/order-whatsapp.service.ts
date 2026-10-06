import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { OrderStatusCatalogService } from '../../catalogs/order-status-catalog.service.js'
import type { AuthUser } from '../../common/types/auth-user.js'
import { formatBs, formatUsd } from '../../common/utils/money-format.js'
import { ContentService } from '../../content/content.service.js'
import { newId } from '../../database/id.js'
import { OrderNote } from '../entities/order-note.entity.js'
import type { OrderStatusHistory } from '../entities/order-status-history.entity.js'
import { Order } from '../entities/order.entity.js'
import { sortByDate } from '../order.mapper.js'
import { OrderAccessService, type IssuedAccessLink } from '../order-access.service.js'
import type { OrderStatus } from '../order-status.js'
import { ORDER_NOT_FOUND } from '../order-status.service.js'
import { hasReceipt } from '../receipt/receipt-availability.js'
import {
    firstName,
    renderWhatsAppTemplate,
    toWhatsAppPhone,
    usedPlaceholders,
    whatsAppUrl,
    withoutFinalPunctuation,
    type WhatsAppValues,
} from './whatsapp-template.js'

/** `POST /admin/orders/:code/whatsapp-message`. */
export interface WhatsAppMessageDto {
    status: OrderStatus
    statusLabel: string
    /** The customer's phone as typed at checkout. */
    customerPhone: string
    /** WhatsApp number ("584141234567"); null when the phone is not a Venezuelan mobile. */
    phone: string | null
    /** The status's template, rendered for this order. */
    text: string
    /** `https://wa.me/<phone>?text=…`; null without a valid phone. */
    url: string | null
    /** The fresh customer link issued for this message (null when the template has no link). */
    link: string | null
    /** Public receipt link included in the message, when the template used it. */
    receiptUrl: string | null
}

/** Latest history entry that moved the order into `status`. */
function latestInto(
    history: readonly OrderStatusHistory[],
    status: OrderStatus,
): OrderStatusHistory | undefined {
    return sortByDate(history)
        .reverse()
        .find((entry) => entry.toStatus === status)
}

/**
 * "Avisar por WhatsApp": the owner messages the customer from her own WhatsApp (a free wa.me link,
 * no WhatsApp API). The text is the current status's template from the catalog, filled in here so
 * the placeholder logic lives in one place. A link placeholder issues a fresh private link,
 * because the stored hashes cannot be turned back into the customer's old link.
 */
@Injectable()
export class OrderWhatsAppService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly catalog: OrderStatusCatalogService,
        private readonly content: ContentService,
        private readonly access: OrderAccessService,
    ) {}

    /**
     * `issuedById` is recorded on the fresh link: the admin asking, or the admin a Telegram chat
     * acts for (null when that chat has none).
     */
    async prepare(code: string, issuedById: string | null): Promise<WhatsAppMessageDto> {
        const order = await this.dataSource.getRepository(Order).findOne({
            where: { code },
            relations: { payments: true, history: true },
        })
        if (!order) throw new NotFoundException(ORDER_NOT_FOUND)

        const [template, label, content] = await Promise.all([
            this.catalog.whatsappTemplate(order.status),
            this.catalog.labeler(),
            this.content.getAll(),
        ])
        const used = usedPlaceholders(template)
        const receipt = used.has('comprobante') && hasReceipt(order, order.payments ?? [])
        let link: IssuedAccessLink | null = null
        if (used.has('enlace') || receipt) {
            link = await this.access.issue(order.id, order.code, issuedById)
        }
        const receiptUrl = receipt && link ? this.access.receiptUrl(order.code, link.token) : null

        const history = order.history ?? []
        const reason = latestInto(history, order.status)?.note
        const shippingNote = latestInto(history, 'ENVIADO')?.note
        const values: WhatsAppValues = {
            nombre: firstName(order.customerName),
            pedido: order.code,
            enlace: link?.url ?? '',
            total: `${formatUsd(order.totalUsd)} (${formatBs(order.totalBs)})`,
            motivo: reason ? withoutFinalPunctuation(reason) : '',
            marca: content.general.brandName,
            envio: shippingNote
                ? withoutFinalPunctuation(shippingNote)
                : order.deliveryMethod === 'pickup'
                  ? 'retiro en tienda'
                  : `a domicilio, ${[order.address, order.city].filter(Boolean).join(', ')}`,
            comprobante: receiptUrl ?? '',
        }
        const text = renderWhatsAppTemplate(template, values)
        const phone = toWhatsAppPhone(order.customerPhone)
        return {
            status: order.status,
            statusLabel: label(order.status),
            customerPhone: order.customerPhone,
            phone,
            text,
            url: phone ? whatsAppUrl(phone, text) : null,
            link: link?.url ?? null,
            receiptUrl,
        }
    }

    /**
     * Leaves an internal note when the owner opens WhatsApp with the message, so the order keeps
     * a trace. The status does not change.
     */
    async recordOpened(code: string, user: AuthUser): Promise<void> {
        const order = await this.dataSource
            .getRepository(Order)
            .findOne({ where: { code }, select: { id: true, status: true } })
        if (!order) throw new NotFoundException(ORDER_NOT_FOUND)
        const label = await this.catalog.labeler()
        await this.dataSource.getRepository(OrderNote).insert({
            id: newId(),
            orderId: order.id,
            authorId: user.id,
            body: `Aviso por WhatsApp preparado (estado ${label(order.status)}).`,
            createdAt: new Date(),
        })
    }
}
