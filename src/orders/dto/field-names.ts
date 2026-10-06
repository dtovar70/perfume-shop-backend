import { feminine, masculine } from '../../common/validation/messages.js'
import { ID_NUMBER_PATTERN, VE_MOBILE_PATTERN } from '../../common/validation/ve-formats.js'

/** Spanish names of the order fields, used to build validation messages. */
export const ORDER_FIELD = {
    fullName: masculine('El nombre y apellido'),
    email: masculine('El correo'),
    phone: masculine('El teléfono'),
    city: feminine('La ciudad'),
    address: feminine('La dirección'),
    notes: feminine('Las notas'),
    deliveryMethod: masculine('El método de entrega'),
    items: masculine('El carrito'),
    productId: masculine('El producto'),
    variantId: feminine('La variante'),
    quantity: feminine('La cantidad'),
    reference: feminine('La referencia'),
    payerBankCode: masculine('El banco'),
    payerPhone: masculine('El teléfono del pago'),
    payerIdNumber: feminine('La cédula del titular'),
    paidOn: feminine('La fecha del pago'),
    amountBs: masculine('El monto pagado'),
    reason: masculine('El motivo'),
    note: feminine('La nota'),
    status: masculine('El estado'),
    acknowledgeStockConflict: feminine('La confirmación del stock'),
    forceStock: feminine('La opción de reactivar sin stock'),
    refundStatus: feminine('La respuesta sobre el reembolso'),
    refundReference: feminine('La referencia del reembolso'),
    code: masculine('El código del pedido'),
} as const

export const ORDER_LIMITS = {
    fullName: { min: 3, max: 100 },
    email: 100,
    city: { min: 2, max: 80 },
    address: { min: 6, max: 100 },
    /** Textareas keep larger limits (also CHECKs on their columns). */
    notes: 300,
    items: 50,
    quantity: 99,
    reason: 500,
    note: 1000,
    search: 100,
    refundReference: 60,
} as const

/**
 * Checkout phone: a Venezuelan mobile ("0424-1234567"), since the order notices go out by
 * WhatsApp. The operator code must also be active in `mobile_prefixes` (checked by the service).
 */
export const CUSTOMER_PHONE_PATTERN = VE_MOBILE_PATTERN
/** Pago Móvil phone: "0412-5550134" (same rule as the checkout phone). */
export const PAYER_PHONE_PATTERN = VE_MOBILE_PATTERN
/** Cédula or RIF of the payer: "V-12345678", "J-123456789". */
export const PAYER_ID_PATTERN = ID_NUMBER_PATTERN
/**
 * Pago Móvil reference: its last 6 digits (the full number is long and error-prone to copy).
 * Payments stored before this rule keep their longer reference.
 */
export const REFERENCE_DIGITS = 6
export const REFERENCE_PATTERN = /^\d{6}$/
export const ORDER_CODE_PATTERN = /^KZ-\d{6,}$/
export const MAX_AMOUNT_BS = 9_999_999_999.99
