import {
    formatCaracasDateTime,
    formatCaracasTime,
    formatDay,
} from '../common/utils/caracas-date.js'
import { formatBs, formatUsd, formatVeNumber } from '../common/utils/money-format.js'
import type { User } from '../auth/entities/user.entity.js'
import { Role } from '../auth/role.enum.js'
import type {
    RateSnapshot,
    RateSyncFailingEvent,
    RateSyncRecoveredEvent,
} from '../exchange-rate/exchange-rate.events.js'
import type { StockConflict, StockConflictLine } from '../orders/entities/order.entity.js'
import type { ContactMessageReceivedEvent } from '../contact/contact.events.js'
import { CONTACT_TOPIC_LABELS } from '../contact/contact.constants.js'
import { firstName } from '../orders/whatsapp/whatsapp-template.js'
import { stockItemName } from '../products/product-stock.js'
import type { PaymentSource } from '../orders/entities/order-payment.entity.js'

/** Moved to common/utils; re-exported for the bot's existing imports. */
export { formatCaracasDateTime, formatCaracasTime, formatDay }

/** Telegram's limits: 4096 characters per message, 1024 per photo caption (after parsing). */
export const TELEGRAM_TEXT_LIMIT = 4096
export const TELEGRAM_CAPTION_LIMIT = 1024

/** Items listed in a message before "…y N más". */
const MAX_ITEM_LINES = 6
const MAX_NAME_LENGTH = 60

/** Escapes text for Telegram's HTML parse mode. Every user-provided value goes through here. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/** "Perfume con nombre largo…" (on the raw text, before escaping). */
export function truncate(value: string, max: number): string {
    const chars = [...value.trim()]
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

/** What Telegram counts: the text without tags, with entities decoded. */
export function visibleLength(html: string): number {
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&').length
}

export interface MessageItem {
    quantity: number
    productName: string
    variantLabel: string | null
}

/**
 * Joins caption lines (HTML) while they fit in `limit` visible characters; the optional lines
 * are dropped from the end first, with a "…" line in their place.
 */
export function fitCaption(
    required: readonly string[],
    optional: readonly string[],
    limit = TELEGRAM_CAPTION_LIMIT,
): string {
    for (let kept = optional.length; kept >= 0; kept--) {
        const lines = [...required, ...optional.slice(0, kept)]
        if (kept < optional.length) lines.push('…')
        const caption = lines.join('\n')
        if (visibleLength(caption) <= limit) return caption
    }
    return truncate(required.join('\n'), limit)
}

export interface PaymentMessageData {
    code: string
    customerName: string
    customerPhone: string
    items: readonly MessageItem[]
    totalUsd: number
    totalBs: number
    exchangeRate: number
    stockConflict: StockConflict | null
    payment: {
        reference: string
        payerBankCode: string
        payerBankName: string
        payerPhone: string
        payerIdNumber: string | null
        paidOn: string
        amountBs: number
        expectedBs: number
        duplicateReference: boolean
        late: boolean
        source: PaymentSource
        /** Admin who recorded a manual payment. */
        recordedByName: string | null
        hasProof: boolean
    }
    /** `<PUBLIC_SITE_URL>/admin/pedidos/<code>`. */
    adminUrl: string
}

export function itemLines(items: readonly MessageItem[]): string[] {
    const lines = items.slice(0, MAX_ITEM_LINES).map((item) => {
        const name = escapeHtml(truncate(item.productName, MAX_NAME_LENGTH))
        const variant = item.variantLabel
            ? ` (${escapeHtml(truncate(item.variantLabel, MAX_NAME_LENGTH))})`
            : ''
        return `• ${item.quantity} × ${name}${variant}`
    })
    const rest = items.length - MAX_ITEM_LINES
    if (rest > 0) lines.push(`<i>…y ${rest} ${rest === 1 ? 'artículo' : 'artículos'} más</i>`)
    return lines
}

/** Unresolved stock conflict lines: "«Yara – 100 ml» pidió 3, hay 1". */
export function stockConflictText(conflict: StockConflict | null): string | null {
    if (!conflict || conflict.resolvedAt) return null
    return stockLinesText(conflict.lines)
}

/** Stock conflict lines: "«Yara – 100 ml» pidió 3, hay 1" (`available` as given). */
export function stockLinesText(lines: readonly StockConflictLine[]): string {
    return lines
        .map(
            (line) =>
                `«${escapeHtml(truncate(stockItemName(line.productName, line.variantLabel), MAX_NAME_LENGTH))}» pidió ${line.requested}, hay ${line.available}`,
        )
        .join('; ')
}

/** Warning lines for the owner; empty when nothing looks odd. */
export function paymentWarnings(data: PaymentMessageData): string[] {
    const { payment } = data
    const warnings: string[] = []
    const difference = Math.round((payment.amountBs - payment.expectedBs) * 100) / 100
    if (difference !== 0) {
        const gap = formatBs(Math.abs(difference))
        warnings.push(
            `⚠️ <b>Monto no coincide:</b> ${difference < 0 ? `faltan ${gap}` : `sobran ${gap}`} (esperado ${formatBs(payment.expectedBs)})`,
        )
    }
    if (payment.duplicateReference) {
        warnings.push('⚠️ <b>Referencia repetida:</b> ya se usó en otro pedido activo')
    }
    if (payment.late) warnings.push('⏰ <b>Pago fuera de plazo</b>')
    const stock = stockConflictText(data.stockConflict)
    if (stock) warnings.push(`📦 <b>Stock insuficiente:</b> ${stock}`)
    return warnings
}

/**
 * The payment notification (HTML). `resolution` is appended once the payment was handled. The
 * text never exceeds Telegram's message limit (items are already capped).
 */
export function paymentMessage(
    data: PaymentMessageData,
    options: { title?: string; resolution?: string | null } = {},
): string {
    const { payment } = data
    const title = options.title ?? '🧾 <b>Nuevo pago por verificar</b>'
    const source =
        payment.source === 'admin'
            ? `🗂️ Registrado manualmente en el panel${payment.recordedByName ? ` por ${escapeHtml(payment.recordedByName)}` : ''}`
            : '🙋 Enviado por el cliente'
    const blocks = [
        [
            `${title} · <b>${escapeHtml(data.code)}</b>`,
            `👤 ${escapeHtml(data.customerName)} · ${escapeHtml(data.customerPhone)}`,
        ],
        itemLines(data.items),
        [
            `💵 <b>Total:</b> ${formatUsd(data.totalUsd)} · ${formatBs(data.totalBs)}`,
            `<i>Tasa BCV ${formatVeNumber(data.exchangeRate)}</i>`,
        ],
        [
            '💳 <b>Pago Móvil</b>',
            `Banco: ${escapeHtml(payment.payerBankName)} (${escapeHtml(payment.payerBankCode)})`,
            `Referencia: <code>${escapeHtml(payment.reference)}</code>`,
            `Teléfono: ${escapeHtml(payment.payerPhone)}${payment.payerIdNumber ? ` · ${escapeHtml(payment.payerIdNumber)}` : ''}`,
            `Fecha: ${formatDay(payment.paidOn)}`,
            `Monto pagado: <b>${formatBs(payment.amountBs)}</b>`,
        ],
        paymentWarnings(data),
        [source + (payment.hasProof ? ' · 📎 con captura' : ' · sin captura')],
    ]
    if (options.resolution) blocks.push([options.resolution])
    return blocks
        .filter((lines) => lines.length)
        .map((lines) => lines.join('\n'))
        .join('\n\n')
}

export interface NewOrderMessageData {
    code: string
    customerName: string
    totalUsd: number
    totalBs: number
    itemCount: number
    items: readonly MessageItem[]
    paymentDueAt: Date
}

export function newOrderMessage(data: NewOrderMessageData): string {
    return [
        `🛒 <b>Nuevo pedido</b> · <b>${escapeHtml(data.code)}</b>`,
        `👤 ${escapeHtml(data.customerName)}`,
        itemLines(data.items).join('\n'),
        `💵 ${formatUsd(data.totalUsd)} · ${formatBs(data.totalBs)} · ${data.itemCount} ${data.itemCount === 1 ? 'artículo' : 'artículos'}`,
        `⏳ Esperando el pago hasta el ${formatCaracasDateTime(data.paymentDueAt)}`,
    ].join('\n')
}

export interface OrderSummaryData {
    code: string
    statusLabel: string
    customerName: string
    customerPhone: string
    items: readonly MessageItem[]
    totalUsd: number
    totalBs: number
    createdAt: Date
    deliveryMethod: 'delivery' | 'pickup'
    latestPayment: { reference: string; amountBs: number; statusLabel: string } | null
}

export function orderSummaryMessage(data: OrderSummaryData): string {
    const lines = [
        `📦 <b>${escapeHtml(data.code)}</b> · ${escapeHtml(data.statusLabel)}`,
        `👤 ${escapeHtml(data.customerName)} · ${escapeHtml(data.customerPhone)}`,
        `🗓️ ${formatCaracasDateTime(data.createdAt)} · ${data.deliveryMethod === 'pickup' ? 'Retiro en tienda' : 'Envío a domicilio'}`,
        '',
        itemLines(data.items).join('\n'),
        '',
        `💵 <b>Total:</b> ${formatUsd(data.totalUsd)} · ${formatBs(data.totalBs)}`,
    ]
    if (data.latestPayment) {
        lines.push(
            `💳 Último pago: ref. <code>${escapeHtml(data.latestPayment.reference)}</code> · ${formatBs(data.latestPayment.amountBs)} · ${escapeHtml(data.latestPayment.statusLabel)}`,
        )
    }
    return lines.join('\n')
}

/** The rate line of the sync alerts: "Tasa actual: 36,5000 Bs/$ (fecha valor 25/09/2026)". */
function currentRateLine(current: RateSnapshot | null): string {
    return current
        ? `Tasa actual: <b>${formatVeNumber(current.rate, 4)} Bs/$</b> (fecha valor ${formatDay(current.effectiveDate)})`
        : 'Todavía no hay ninguna tasa guardada.'
}

/** Sent once when the automatic rate sync keeps failing. */
export function rateSyncFailingMessage(event: RateSyncFailingEvent): string {
    const { current } = event
    const pause = !current
        ? '⛔ La tienda no puede recibir pedidos hasta que haya una tasa.'
        : current.isStale
          ? '⛔ <b>Los pedidos ya están pausados</b>: la tasa guardada venció.'
          : `⏳ Si no llega una tasa nueva, <b>los pedidos se pausan el ${formatCaracasDateTime(new Date(current.usableUntil))}</b>.`
    return [
        '⚠️ <b>No se pudo obtener la tasa del BCV</b>',
        `Fallaron ${event.consecutiveFailures} intentos seguidos (BCV y DolarApi).`,
        currentRateLine(current),
        pause,
        'Puedes cargarla a mano en el panel, sección <b>Tasa BCV</b>.',
    ].join('\n')
}

/** Sent once when a sync succeeds after the failing alert. */
export function rateSyncRecoveredMessage(event: RateSyncRecoveredEvent): string {
    const lines = ['✅ <b>La tasa del BCV se volvió a obtener</b>', currentRateLine(event.current)]
    if (event.current?.isStale) {
        lines.push('⚠️ Esa tasa sigue vencida: los pedidos siguen pausados.')
    }
    return lines.join('\n')
}

/** Room left for the customer's text in a contact notice (the header lines are short). */
const MAX_CONTACT_TEXT_LENGTH = 3500

/**
 * "📨 Nuevo mensaje de contacto": who wrote, how to answer and the message. Every customer value
 * is escaped; the text is cut on the raw value so the message stays under Telegram's limit.
 */
export function contactMessage(event: ContactMessageReceivedEvent): string {
    const lines = [
        '📨 <b>Nuevo mensaje de contacto</b>',
        `👤 ${escapeHtml(event.fullName)}`,
        `✉️ ${escapeHtml(event.email)}`,
    ]
    if (event.phone) lines.push(`📱 WhatsApp: ${escapeHtml(event.phone)}`)
    lines.push(
        `🏷️ ${escapeHtml(CONTACT_TOPIC_LABELS[event.topic])}`,
        `🗓️ ${formatCaracasDateTime(new Date(event.receivedAt))}`,
        '',
        escapeHtml(truncate(event.message, MAX_CONTACT_TEXT_LENGTH)),
    )
    return lines.join('\n')
}

/** Pre-filled text of the "Abrir WhatsApp" button: "Hola Ana, te escribimos de KaiZen…". */
export function contactWhatsAppGreeting(fullName: string): string {
    const name = firstName(fullName)
    return `Hola${name ? ` ${name}` : ''}, te escribimos de KaiZen por el mensaje que nos enviaste desde la página. 😊`
}

export const HELP_TEXT = [
    '<b>Comandos</b>',
    '/pendientes — pagos por verificar',
    '/pedido KZ-000012 — resumen de un pedido',
    '/micuenta — tu cuenta del panel vinculada a este chat',
    '/ayuda — esta ayuda',
    '/salir — desvincular este chat',
].join('\n')

export const WELCOME_MESSAGE = [
    '✨ <b>¡Listo! Este chat quedó vinculado a KaiZen.</b>',
    '',
    'Te voy a avisar cada vez que llegue un pago por verificar, y podrás confirmarlo o rechazarlo desde aquí mismo. Todo queda sincronizado con el panel web.',
    '',
    HELP_TEXT,
].join('\n')

export const PRIVATE_BOT_MESSAGE =
    '🔒 Hola, este es un bot privado del equipo de KaiZen. Si trabajas con nosotros, pide un código de vinculación en el panel de administración (sección Telegram) y envíalo así: /start 123456'

const ROLE_LABELS: Record<Role, string> = {
    [Role.ADMIN]: 'Administrador',
    [Role.EDITOR]: 'Editor',
}

/** `/micuenta`: the panel account that linked this chat. */
export function accountMessage(
    user: Pick<User, 'name' | 'email' | 'role' | 'isActive'> | null,
): string {
    if (!user) {
        return 'Este chat no está asociado a ninguna cuenta del panel. Vincúlalo de nuevo desde el panel (sección Telegram).'
    }
    return [
        '👤 <b>Cuenta del panel vinculada a este chat</b>',
        `Nombre: ${escapeHtml(user.name)}`,
        `Correo: ${escapeHtml(user.email)}`,
        `Rol: ${ROLE_LABELS[user.role] ?? escapeHtml(user.role)}`,
        `Estado: ${user.isActive ? 'Activa ✅' : 'Inactiva'}`,
        '',
        'Si olvidas tu contraseña, en la página de inicio de sesión toca “¿Olvidaste tu contraseña?” y te enviaré aquí un código.',
    ].join('\n')
}
