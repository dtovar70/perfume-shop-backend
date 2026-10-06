import { masculine } from '../common/validation/messages.js'
import { TEXT_INPUT_MAX_LENGTH } from '../common/validation/text-limits.js'

/**
 * Topics of the contact form, with the labels the storefront shows. Mirrored by
 * the storefront's src/views/contact/schema/contact.schema.ts.
 */
export const CONTACT_TOPICS = ['asesoria', 'mayoreo', 'pedido', 'otro'] as const
export type ContactTopic = (typeof CONTACT_TOPICS)[number]

export const CONTACT_TOPIC_LABELS: Record<ContactTopic, string> = {
    asesoria: 'Quiero asesoría para elegir un perfume',
    mayoreo: 'Pedido por mayor',
    pedido: 'Consulta sobre un pedido',
    otro: 'Otro tema',
}

export const CONTACT_LIMITS = {
    fullName: { min: 3, max: TEXT_INPUT_MAX_LENGTH },
    email: TEXT_INPUT_MAX_LENGTH,
    /** A textarea: its own, larger limit (the storefront stops at the same length). */
    message: { min: 15, max: 600 },
    /** The hidden honeypot input; anything longer is not a person either. */
    website: 200,
} as const

/** Spanish names of the contact fields, used to build validation messages. */
export const CONTACT_FIELD = {
    fullName: masculine('El nombre y apellido'),
    email: masculine('El correo'),
    phone: masculine('El WhatsApp'),
    topic: masculine('El tema'),
    message: masculine('El mensaje'),
    website: masculine('El sitio web'),
} as const

/** Per email: 3 messages every 15 minutes (the IP limit lives on the route). */
export const CONTACT_EMAIL_LIMIT = 3
export const CONTACT_WINDOW_MS = 15 * 60_000

export const CONTACT_MESSAGE_SENT = 'Recibimos tu mensaje. Te respondemos pronto.'
export const CONTACT_TOO_MANY =
    'Enviaste varios mensajes seguidos. Espera unos minutos e intenta de nuevo.'
/** Machine-readable reason of the 503 (nobody can receive the message right now). */
export const CONTACT_UNAVAILABLE = 'CONTACT_UNAVAILABLE'
export const CONTACT_UNAVAILABLE_MESSAGE = 'No pudimos enviar tu mensaje. Escríbenos por WhatsApp.'
