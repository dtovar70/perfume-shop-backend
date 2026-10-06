/** Lowercase + strip diacritics, so "Mamá" matches "mama". */
export function normalizeText(value: string): string {
    return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** URL-safe slug from free text: "Café Árabe Intenso" -> "cafe-arabe-intenso". */
export function slugify(value: string): string {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const HEX_COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/
