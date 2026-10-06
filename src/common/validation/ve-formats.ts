/**
 * Venezuelan formats shared by the content and order DTOs. Mirrored by the storefront in
 * frontend-perfume-shop/src/utils/veFormats.ts.
 */

/**
 * Venezuelan mobile number as stored: operator code, dash, seven digits ("0424-1234567"). The
 * code must also be an active row of `mobile_prefixes` (`MobilePrefixesService`), checked by the
 * services after the DTO.
 */
export const VE_MOBILE_PATTERN = /^04\d{2}-\d{7}$/

/** Any Venezuelan number, landlines included: "0412-5550134", "0251-1234567". */
export const VE_PHONE_PATTERN = /^0\d{3}-\d{7}$/

/** The operator code of a mobile number: "0424-1234567" -> "0424". */
export function mobilePrefixOf(phone: string): string {
    return phone.slice(0, 4)
}

/**
 * Document types a cédula or RIF may start with: V (venezolano), J (jurídico), G (gobierno).
 * They stay in code because the pattern depends on them.
 */
export const ID_NUMBER_LETTERS = ['V', 'J', 'G'] as const

/** Cédula or RIF: letter, dash and 6 to 9 digits ("V-12345678", "J-123456789"). */
export const ID_NUMBER_PATTERN = /^[VJG]-\d{6,9}$/

export const ID_NUMBER_MESSAGE = 'Usa V, J o G seguido de 6 a 9 números, por ejemplo V-12345678.'
