/**
 * Lengths, list sizes and formats of the editable content. Mirrored by the admin forms in
 * frontend-perfume-shop/src/views/admin/content/schema/content.schema.ts.
 */
export const CONTENT_LIMITS = {
    /** Button labels, badges, eyebrows, short list items. */
    label: 40,
    title: 90,
    /** Titles of list items (steps, values). */
    itemTitle: 60,
    question: 100,
    /** Subtitles and descriptions edited in a textarea. */
    text: 300,
    /** Descriptions edited in a single-line field (every one-line field stops at 100). */
    shortText: 100,
    /** Paragraphs and FAQ answers. */
    paragraph: 1000,
    brandName: 60,
    tagline: 80,
    titleSuffix: 70,
    metaDescription: 300,
    announcement: 80,
    searchPlaceholder: 60,
    statValue: 12,
    email: 100,
    city: 80,
    schedule: 100,
    // Same limit as `banks.name`: the name is copied from the banks catalog.
    bankName: 100,
    holderName: 80,
    instructions: 500,
    testimonialQuote: 400,
    testimonialName: 60,
    testimonialProduct: 80,
} as const

export const CONTENT_LIST_SIZES = {
    announcements: { minItems: 1, maxItems: 8 },
    heroFeatures: { minItems: 0, maxItems: 4 },
    steps: { minItems: 1, maxItems: 6 },
    paragraphs: { minItems: 1, maxItems: 6 },
    values: { minItems: 1, maxItems: 8 },
    stats: { minItems: 1, maxItems: 8 },
    faq: { minItems: 1, maxItems: 12 },
    testimonials: { minItems: 0, maxItems: 12 },
} as const

export {
    ID_NUMBER_MESSAGE,
    ID_NUMBER_PATTERN,
    VE_MOBILE_PATTERN,
    VE_PHONE_PATTERN,
} from '../../common/validation/ve-formats.js'
export const BANK_CODE_PATTERN = /^\d{4}$/
/** Instagram / TikTok handle without "@"; empty hides the link. */
export const SOCIAL_HANDLE_PATTERN = /^(?:[A-Za-z0-9._]{1,30})?$/
