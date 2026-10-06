import { RECEIPT_STATUSES, type OrderStatus } from '../order-status.js'

/**
 * Placeholders of the WhatsApp message templates (`order_statuses.whatsapp_template`), filled in
 * by `renderWhatsAppTemplate`. Mirrored in frontend-perfume-shop/src/views/admin/catalogs/utils/whatsappTemplate.ts
 * (list, descriptions and the preview's sample data): keep both in sync.
 */
export const WHATSAPP_PLACEHOLDERS = [
    /** The customer's first name. */
    'nombre',
    /** The order code, "KZ-000123". */
    'pedido',
    /** A fresh private link to the customer's order page. */
    'enlace',
    /** "$36,00 (Bs. 30.760,69)". */
    'total',
    /** Note of the latest move into the current status (rejection or cancellation reason). */
    'motivo',
    /** Brand name (content `general`). */
    'marca',
    /** Shipping note or tracking; without one, the delivery method and address. */
    'envio',
    /** Public link to the receipt PDF. Only in statuses that have one (`RECEIPT_STATUSES`). */
    'comprobante',
] as const

export type WhatsAppPlaceholder = (typeof WHATSAPP_PLACEHOLDERS)[number]
export type WhatsAppValues = Record<WhatsAppPlaceholder, string>

const TOKEN = /\{([^{}]*)\}/g

function isPlaceholder(name: string): name is WhatsAppPlaceholder {
    return (WHATSAPP_PLACEHOLDERS as readonly string[]).includes(name)
}

/** Placeholders a template uses (known ones only). */
export function usedPlaceholders(template: string): Set<WhatsAppPlaceholder> {
    const used = new Set<WhatsAppPlaceholder>()
    for (const [, name] of template.matchAll(TOKEN)) {
        if (name !== undefined && isPlaceholder(name)) used.add(name)
    }
    return used
}

const PLACEHOLDER_LIST = WHATSAPP_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')

/**
 * Spanish error for a template, or null when it is valid: every `{…}` must be a known
 * placeholder, braces are only used for them, and `{comprobante}` only fits statuses that have a
 * receipt. `status` is omitted when the status is not known yet (format-only check).
 */
export function whatsAppTemplateError(template: string, status?: OrderStatus): string | null {
    const unknown = [...template.matchAll(TOKEN)]
        .map(([token, name]) => (name !== undefined && isPlaceholder(name) ? null : token))
        .filter((token): token is string => token !== null)
    if (unknown.length) {
        const list = [...new Set(unknown)].join(', ')
        return `El mensaje de WhatsApp usa ${unknown.length === 1 ? 'un marcador desconocido' : 'marcadores desconocidos'}: ${list}. Solo se admiten ${PLACEHOLDER_LIST}.`
    }
    if (/[{}]/.test(template.replace(TOKEN, ''))) {
        return 'Las llaves { } del mensaje de WhatsApp solo se usan para los marcadores, por ejemplo {nombre}.'
    }
    if (
        status &&
        usedPlaceholders(template).has('comprobante') &&
        !RECEIPT_STATUSES.includes(status)
    ) {
        return 'El marcador {comprobante} solo se puede usar en los estados con el pago verificado.'
    }
    return null
}

/** Fills the placeholders and tidies what an empty value leaves behind (spaces, "()", " ."). */
export function renderWhatsAppTemplate(template: string, values: WhatsAppValues): string {
    const filled = template.replace(TOKEN, (token, name: string) =>
        isPlaceholder(name) ? values[name] : token,
    )
    return filled
        .split('\n')
        .map((line) =>
            line
                .replace(/\(\s*\)/g, '')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/[ \t]+([.,;:!?)])/g, '$1')
                .replace(/:\s*\./g, '.')
                .trim(),
        )
        .join('\n')
        .trim()
}

/** "Ana María Pérez" -> "Ana". */
export function firstName(fullName: string): string {
    return fullName.trim().split(/\s+/)[0] ?? ''
}

/** "Rechazado por monto." -> "Rechazado por monto" (the template adds its own punctuation). */
export function withoutFinalPunctuation(text: string): string {
    return text.trim().replace(/[.!?;:,\s]+$/u, '')
}

/** Venezuelan mobile prefixes (Movilnet 416/426, Movistar 414/424, Digitel 412/422). */
const MOBILE = /^4(?:1[246]|2[246])\d{7}$/

/**
 * The customer's phone as a WhatsApp number ("0414-1234567" -> "584141234567"), or null when it
 * is not a Venezuelan mobile (a landline cannot receive WhatsApp through wa.me). Accepts the
 * local form (04xx), the international one (+58 / 0058 / 58) and the bare 10 digits.
 */
export function toWhatsAppPhone(phone: string): string | null {
    let digits = phone.replace(/\D/g, '')
    if (digits.startsWith('0058')) digits = digits.slice(4)
    else if (digits.startsWith('58') && digits.length === 12) digits = digits.slice(2)
    else if (digits.startsWith('0')) digits = digits.slice(1)
    return MOBILE.test(digits) ? `58${digits}` : null
}

/** `https://wa.me/<phone>?text=<message>` (opens WhatsApp with the message written). */
export function whatsAppUrl(phone: string, text: string): string {
    return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
}

/**
 * The templates seeded by the migration, one per status. Warm and short; the owner edits them in
 * Catálogos → Estados de pedido.
 */
export const DEFAULT_WHATSAPP_TEMPLATES: Record<OrderStatus, string> = {
    PENDIENTE_PAGO:
        '¡Hola {nombre}! ✨ Gracias por tu pedido {pedido} en {marca}. Te recordamos que el total es {total}. Puedes pagar por Pago Móvil y subir tu comprobante aquí: {enlace}',
    PENDIENTE_VERIFICACION:
        '¡Hola {nombre}! 🙌 Recibimos el comprobante de tu pedido {pedido} y lo estamos verificando. Te avisamos apenas lo confirmemos. Puedes ver el estado aquí: {enlace}',
    PAGO_VERIFICADO:
        '¡Hola {nombre}! ✅ Confirmamos tu pago del pedido {pedido}. Ya estamos preparando tu perfume. Tu comprobante: {comprobante} · Sigue tu pedido: {enlace}',
    PAGO_RECHAZADO:
        'Hola {nombre} 👋 Revisamos el pago de tu pedido {pedido} y no pudimos aprobarlo: {motivo}. Puedes subir un nuevo comprobante aquí: {enlace}',
    EN_PRODUCCION:
        '¡Hola {nombre}! ✨ Tu pedido {pedido} ya se está preparando: revisamos y empacamos tu perfume con mucho cuidado. Síguelo aquí: {enlace}',
    LISTO_PARA_ENTREGA:
        '¡Hola {nombre}! 🎉 Tu pedido {pedido} está listo. Muy pronto coordinamos la entrega contigo. Detalles: {enlace}',
    ENVIADO:
        '¡Hola {nombre}! 🚚 Tu pedido {pedido} ya va en camino. Datos del envío: {envio}. Síguelo aquí: {enlace}',
    ENTREGADO:
        '¡Hola {nombre}! 💛 Tu pedido {pedido} ya fue entregado. Gracias por confiar en {marca}, ¡esperamos que lo disfrutes mucho! Tu comprobante: {comprobante}',
    CANCELADO:
        'Hola {nombre}. Te escribimos por tu pedido {pedido}: lo cancelamos ({motivo}). Si hiciste un pago o tienes alguna duda, respóndenos por aquí y lo resolvemos juntos.',
    EXPIRADO:
        'Hola {nombre} 👋 El plazo para pagar tu pedido {pedido} venció. Si ya hiciste el pago, súbelo aquí y lo verificamos: {enlace}',
}
