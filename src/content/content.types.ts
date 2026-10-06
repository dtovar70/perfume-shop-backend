/**
 * Editable site content: one JSON value per section, stored in `site_content`.
 *
 * Mirrored in frontend-perfume-shop/src/@types/content.ts. Keep both files identical (only the
 * comments that point at each other differ), so the storefront and the API agree on the shape.
 *
 * Text conventions shared by the API and the storefront:
 * - Highlighted words (painted pink in headings) are wrapped in asterisks: "Tus *favoritos*".
 * - Placeholders in braces are replaced when rendered, e.g. "{envioGratis}" -> "$35". Each field
 *   accepts only the placeholders listed in `CONTENT_PLACEHOLDERS`.
 */

export const CONTENT_SECTIONS = [
    'general',
    'announcements',
    'home',
    'about',
    'contact',
    'contactPage',
    'shipping',
    'payment',
] as const

export type ContentSection = (typeof CONTENT_SECTIONS)[number]

export function isContentSection(value: string): value is ContentSection {
    return (CONTENT_SECTIONS as readonly string[]).includes(value)
}

/** Placeholders and what they render. */
export const CONTENT_PLACEHOLDERS = {
    /** Free-shipping threshold, as money: "$35". */
    envioGratis: '{envioGratis}',
    /** Flat shipping rate, as money: "$4". */
    tarifaEnvio: '{tarifaEnvio}',
    /** Production-time copy of the shipping section. */
    produccion: '{produccion}',
    /** Number of categories in words: "Tres formatos". */
    categorias: '{categorias}',
    /** Brand name of the general section. */
    marca: '{marca}',
    /** City of the contact section. */
    ciudad: '{ciudad}',
} as const

export type ContentPlaceholder = keyof typeof CONTENT_PLACEHOLDERS

/** Icons a brand value on the About page can use (lucide icons on the storefront). */
export const ABOUT_VALUE_ICONS = [
    'palette',
    'heart-handshake',
    'timer',
    'leaf',
    'sparkles',
    'star',
    'truck',
    'shield-check',
] as const

export type AboutValueIcon = (typeof ABOUT_VALUE_ICONS)[number]

export interface GeneralContent {
    brandName: string
    tagline: string
    /** Short description shown in the footer. */
    description: string
    /** document.title is "<brandName> — <titleSuffix>" (just the brand when empty). */
    titleSuffix: string
    /** `<meta name="description">`. Accepts {envioGratis}. */
    metaDescription: string
    searchPlaceholder: string
}

export interface AnnouncementsContent {
    /** Ticker messages, in order. Accept {envioGratis} and {tarifaEnvio}. */
    messages: string[]
}

export interface HomeStep {
    title: string
    description: string
}

/** A real customer review shown on the home page. */
export interface HomeTestimonial {
    quote: string
    name: string
    /** Empty hides it. */
    city: string
    /** What the customer bought, free text. Empty hides it. */
    product: string
}

export const HERO_MEDIA_TYPES = ['image', 'video'] as const

export type HeroMediaType = (typeof HERO_MEDIA_TYPES)[number]

/**
 * Photo or short video of the home hero, uploaded from the admin. Null shows the featured
 * products instead.
 */
export interface HeroMedia {
    type: HeroMediaType
    /** Uploaded file (storage URL) or any https URL. */
    url: string
    /** Still frame shown before a video plays, or instead of it (reduced motion, data saver). */
    posterUrl: string | null
    /** Describes the media; empty marks it as decorative. */
    alt: string
}

export interface HomeContent {
    heroBadge: string
    /** Accepts *highlights*. */
    heroTitle: string
    heroSubtitle: string
    heroPrimaryCta: string
    heroSecondaryCta: string
    heroFeatures: string[]
    heroMedia: HeroMedia | null
    categoriesEyebrow: string
    categoriesTitle: string
    /** Accepts {categorias}. */
    categoriesDescription: string
    featuredEyebrow: string
    featuredTitle: string
    featuredDescription: string
    featuredCta: string
    stepsEyebrow: string
    stepsTitle: string
    stepsDescription: string
    steps: HomeStep[]
    testimonialsEyebrow: string
    testimonialsTitle: string
    /** Real reviews, in order. Empty hides the whole section. */
    testimonials: HomeTestimonial[]
    ctaBadge: string
    ctaTitle: string
    ctaDescription: string
    ctaPrimary: string
    ctaSecondary: string
}

export interface AboutValue {
    icon: AboutValueIcon
    title: string
    description: string
}

export interface AboutStat {
    value: string
    label: string
}

export interface AboutContent {
    badge: string
    title: string
    /** Accept {marca} and {ciudad}. The first one is set larger. */
    paragraphs: string[]
    ctaLabel: string
    imageBadge: string
    valuesEyebrow: string
    valuesTitle: string
    valuesDescription: string
    values: AboutValue[]
    statsEyebrow: string
    statsTitle: string
    stats: AboutStat[]
}

export interface ContactContent {
    email: string
    /** Venezuelan number, "0412-5550134". Shown as "+58 412 555 0134". */
    phone: string
    /** Mobile number for wa.me links, "0412-5550134". */
    whatsapp: string
    city: string
    schedule: string
    /** Handles without "@"; empty hides the link. */
    instagram: string
    tiktok: string
}

export interface FaqItem {
    question: string
    answer: string
}

export interface ContactPageContent {
    badge: string
    title: string
    intro: string
    faqEyebrow: string
    faqTitle: string
    /** Accept {envioGratis}, {tarifaEnvio} and {produccion}. */
    faq: FaqItem[]
}

export interface ShippingContent {
    /** USD. Orders at or above it ship free. */
    freeThreshold: number
    /** USD charged below the threshold. */
    flatRate: number
    /** Accepts {envioGratis}. */
    freeShippingCopy: string
    productionCopy: string
}

export interface PaymentContent {
    /** Four-digit bank code, "0102". */
    bankCode: string
    bankName: string
    phone: string
    /** Cédula or RIF, "V-12345678" / "J-123456789". */
    idNumber: string
    holderName: string
    instructions: string
}

export interface SiteContent {
    general: GeneralContent
    announcements: AnnouncementsContent
    home: HomeContent
    about: AboutContent
    contact: ContactContent
    contactPage: ContactPageContent
    shipping: ShippingContent
    payment: PaymentContent
}

/** Checkout needs every Pago Móvil detail (instructions are optional). */
export function isPaymentConfigured(payment: PaymentContent): boolean {
    return [
        payment.bankCode,
        payment.bankName,
        payment.phone,
        payment.idNumber,
        payment.holderName,
    ].every((value) => value.trim() !== '')
}
