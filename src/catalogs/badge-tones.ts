/**
 * Colors an order status badge may take: the tones of the storefront's `Badge` component
 * (frontend-perfume-shop/src/components/ui/Badge.tsx). Enforced by a CHECK on `order_statuses.tone`.
 */
export const BADGE_TONES = ['blush', 'sky', 'mint', 'butter', 'lilac', 'solid', 'neutral'] as const

export type BadgeTone = (typeof BADGE_TONES)[number]
