import { formatCaracasDateTime, formatDay } from '../../common/utils/caracas-date.js'
import { formatBs, formatUsd, formatVeNumber } from '../../common/utils/money-format.js'
import type { ContactContent, PaymentContent } from '../../content/content.types.js'
import { renderEmail, type EmailBlock, type EmailInline } from '../../mail/email-layout.js'
import type { OrderItem } from '../entities/order-item.entity.js'
import type { Order } from '../entities/order.entity.js'
import { firstName, toWhatsAppPhone } from '../whatsapp/whatsapp-template.js'

/** A rendered customer email (the recipient is added by the sender). */
export interface OrderEmail {
    subject: string
    html: string
    text: string
}

/** What every order email needs from the site content. */
export interface OrderEmailShop {
    brandName: string
    contact: ContactContent
}

export type OrderReceivedData = Pick<
    Order,
    | 'code'
    | 'customerName'
    | 'deliveryMethod'
    | 'address'
    | 'city'
    | 'subtotalUsd'
    | 'shippingUsd'
    | 'totalUsd'
    | 'totalBs'
    | 'exchangeRate'
    | 'exchangeRateDate'
    | 'paymentDueAt'
> & {
    items: Pick<
        OrderItem,
        'productName' | 'variantLabel' | 'quantity' | 'unitPriceUsd' | 'lineTotalUsd' | 'sortOrder'
    >[]
}

export const DELIVERY_METHOD_LABELS = {
    delivery: 'Envío a domicilio',
    pickup: 'Retiro en tienda',
} as const

/** "¿Dudas? Responde este correo o escríbenos por WhatsApp." (WhatsApp only when set). */
function helpParagraph(contact: ContactContent): EmailBlock {
    const whatsapp = toWhatsAppPhone(contact.whatsapp)
    const parts: EmailInline[] = whatsapp
        ? [
              '¿Tienes alguna duda? Responde este correo o escríbenos por ',
              { href: `https://wa.me/${whatsapp}`, label: `WhatsApp (${contact.whatsapp.trim()})` },
              ' y con gusto te ayudamos.',
          ]
        : ['¿Tienes alguna duda? Responde este correo y con gusto te ayudamos.']
    return { kind: 'paragraph', parts }
}

function itemsBlock(items: OrderReceivedData['items']): EmailBlock {
    return {
        kind: 'items',
        items: [...items]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((item) => ({
                title: item.variantLabel
                    ? `${item.productName} · ${item.variantLabel}`
                    : item.productName,
                details: [`Cantidad: ${item.quantity} × ${formatUsd(item.unitPriceUsd)}`],
                amount: formatUsd(item.lineTotalUsd),
            })),
    }
}

function paymentBlocks(order: OrderReceivedData, payment: PaymentContent | null): EmailBlock[] {
    if (!payment) {
        return [
            {
                kind: 'paragraph',
                parts: [
                    'Escríbenos para coordinar tu pago y te pasamos los datos de Pago Móvil. Recuerda indicar tu número de pedido ',
                    { bold: order.code },
                    '.',
                ],
            },
        ]
    }
    const blocks: EmailBlock[] = [
        {
            kind: 'rows',
            title: 'Datos para tu Pago Móvil',
            rows: [
                { label: 'Banco', value: `${payment.bankCode} - ${payment.bankName}` },
                { label: 'Teléfono', value: payment.phone },
                { label: 'Cédula / RIF', value: payment.idNumber },
                { label: 'Titular', value: payment.holderName },
                { label: 'Monto exacto', value: formatBs(order.totalBs), strong: true },
                { label: 'Concepto', value: `Pedido ${order.code}` },
            ],
        },
    ]
    if (payment.instructions.trim()) {
        blocks.push({ kind: 'note', parts: [payment.instructions.trim()] })
    }
    return blocks
}

function deliveryBlock(order: OrderReceivedData): EmailBlock {
    const rows: { label: string; value: string }[] = [
        { label: 'Método', value: DELIVERY_METHOD_LABELS[order.deliveryMethod] },
    ]
    if (order.deliveryMethod === 'delivery') {
        rows.push({
            label: 'Dirección',
            value: [order.address, order.city]
                .map((part) => part.trim())
                .filter(Boolean)
                .join(', '),
        })
    }
    return { kind: 'rows', title: 'Entrega', rows }
}

/** "Pedido recibido": sent once, right after checkout, with a fresh private link. */
export function orderReceivedEmail(
    order: OrderReceivedData,
    payment: PaymentContent | null,
    link: string,
    shop: OrderEmailShop,
): OrderEmail {
    const deadline = formatCaracasDateTime(order.paymentDueAt)
    const shipping =
        order.deliveryMethod === 'pickup'
            ? 'Sin costo (retiro)'
            : order.shippingUsd === 0
              ? 'Gratis'
              : formatUsd(order.shippingUsd)
    const blocks: EmailBlock[] = [
        { kind: 'heading', text: `¡Gracias por tu pedido, ${firstName(order.customerName)}!` },
        {
            kind: 'paragraph',
            parts: [
                'Recibimos tu pedido ',
                { bold: order.code },
                ' y ya lo apartamos para ti. Para confirmarlo solo falta tu pago por Pago Móvil.',
            ],
        },
        itemsBlock(order.items),
        {
            kind: 'rows',
            rows: [
                { label: 'Subtotal', value: formatUsd(order.subtotalUsd) },
                { label: 'Envío', value: shipping },
                { label: 'Total', value: formatUsd(order.totalUsd), strong: true },
                { label: 'Total en bolívares', value: formatBs(order.totalBs), strong: true },
                {
                    label: `Tasa BCV del ${formatDay(order.exchangeRateDate)}`,
                    value: `${formatVeNumber(order.exchangeRate, 4)} Bs/$`,
                },
            ],
        },
        ...paymentBlocks(order, payment),
        {
            kind: 'paragraph',
            parts: [
                'Tienes hasta el ',
                { bold: `${deadline} (hora de Venezuela)` },
                ' para pagar; el monto en bolívares se mantiene durante todo ese plazo. Cuando pagues, sube tu comprobante desde la página de tu pedido.',
            ],
        },
        deliveryBlock(order),
        { kind: 'button', href: link, label: 'Ver mi pedido' },
        {
            kind: 'note',
            parts: [
                'Este enlace es privado: con él ves el estado de tu pedido y subes tu comprobante. No lo compartas.',
            ],
        },
        helpParagraph(shop.contact),
    ]
    const rendered = renderEmail({
        brandName: shop.brandName,
        contact: shop.contact,
        preheader: `Total ${formatBs(order.totalBs)}. Paga por Pago Móvil antes del ${deadline}.`,
        blocks,
    })
    return { subject: `Recibimos tu pedido ${order.code}`, ...rendered }
}

/** "Consultar mi pedido": a fresh private link, sent only to the order's own email. */
export function orderLinkEmail(
    order: Pick<Order, 'code' | 'customerName'>,
    link: string,
    shop: OrderEmailShop,
): OrderEmail {
    const blocks: EmailBlock[] = [
        { kind: 'heading', text: `Hola, ${firstName(order.customerName)}` },
        {
            kind: 'paragraph',
            parts: [
                'Nos pediste el enlace de tu pedido ',
                { bold: order.code },
                '. Tócalo para ver su estado, los datos de pago o subir tu comprobante.',
            ],
        },
        { kind: 'button', href: link, label: 'Ver mi pedido' },
        {
            kind: 'note',
            parts: [
                'Este enlace es privado: no lo compartas. Si no lo pediste tú, ignora este correo; nadie puede ver tu pedido sin él.',
            ],
        },
        helpParagraph(shop.contact),
    ]
    const rendered = renderEmail({
        brandName: shop.brandName,
        contact: shop.contact,
        preheader: `El enlace privado de tu pedido ${order.code}.`,
        blocks,
    })
    return { subject: `Tu enlace para ver el pedido ${order.code}`, ...rendered }
}
