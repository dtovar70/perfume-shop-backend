import { Transform, Type, type TransformFnParams } from 'class-transformer'
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsEmail,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator'
import { msg } from '../../common/validation/messages.js'
import { MaxInputLength } from '../../common/validation/text-limits.js'
import {
    CUSTOMER_PHONE_PATTERN,
    ORDER_FIELD as FIELD,
    ORDER_LIMITS as LIMITS,
} from './field-names.js'

const trim = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value

/** Empty strings are treated as "not sent" for optional fields. */
const trimOrUndefined = ({ value }: TransformFnParams): unknown => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
}

export const DELIVERY_METHODS = ['delivery', 'pickup'] as const

/**
 * One cart line. Only identifiers and quantities: every price is read from the database, and
 * any extra field (e.g. a client-side `unitPrice`) is rejected by the global pipe.
 */
export class OrderItemInputDto {
    @Transform(trim)
    @IsString({ message: msg.text(FIELD.productId) })
    @IsNotEmpty({ message: msg.required(FIELD.productId) })
    @MaxLength(80, { message: msg.maxLength(FIELD.productId, 80) })
    productId: string

    @IsOptional()
    @Transform(trimOrUndefined)
    @IsString({ message: msg.text(FIELD.variantId) })
    @MaxLength(80, { message: msg.maxLength(FIELD.variantId, 80) })
    variantId?: string

    @IsInt({ message: msg.integer(FIELD.quantity) })
    @Min(1, { message: msg.min(FIELD.quantity, 1) })
    @Max(LIMITS.quantity, { message: msg.max(FIELD.quantity, LIMITS.quantity) })
    quantity: number
}

/** Body of `POST /orders`: the checkout form plus the cart lines. */
export class CreateOrderDto {
    @Transform(trim)
    @IsString({ message: msg.text(FIELD.fullName) })
    @MinLength(LIMITS.fullName.min, { message: 'Escribe tu nombre y apellido.' })
    @MaxLength(LIMITS.fullName.max, { message: msg.maxLength(FIELD.fullName, LIMITS.fullName.max) })
    fullName: string

    @Transform(trim)
    @IsString({ message: msg.text(FIELD.email) })
    @IsEmail({}, { message: msg.email(FIELD.email) })
    @MaxLength(LIMITS.email, { message: msg.maxLength(FIELD.email, LIMITS.email) })
    email: string

    @Transform(trim)
    @IsString({ message: msg.text(FIELD.phone) })
    @MaxInputLength(FIELD.phone)
    @Matches(CUSTOMER_PHONE_PATTERN, {
        message: 'Escribe un celular válido, por ejemplo 0412-5550134.',
    })
    phone: string

    @Transform(trim)
    @IsString({ message: msg.text(FIELD.city) })
    @MinLength(LIMITS.city.min, { message: 'Escribe tu ciudad.' })
    @MaxLength(LIMITS.city.max, { message: msg.maxLength(FIELD.city, LIMITS.city.max) })
    city: string

    @Transform(trim)
    @IsString({ message: msg.text(FIELD.address) })
    @MinLength(LIMITS.address.min, { message: 'Escribe una dirección completa.' })
    @MaxLength(LIMITS.address.max, { message: msg.maxLength(FIELD.address, LIMITS.address.max) })
    address: string

    @IsOptional()
    @Transform(trim)
    @IsString({ message: msg.text(FIELD.notes) })
    @MaxLength(LIMITS.notes, { message: msg.maxLength(FIELD.notes, LIMITS.notes) })
    notes?: string

    @IsIn(DELIVERY_METHODS, { message: msg.invalid(FIELD.deliveryMethod) })
    deliveryMethod: (typeof DELIVERY_METHODS)[number]

    @IsArray({ message: msg.list(FIELD.items) })
    @ArrayMinSize(1, { message: 'Tu carrito está vacío.' })
    @ArrayMaxSize(LIMITS.items, { message: msg.listMaxSize(FIELD.items, LIMITS.items) })
    @ValidateNested({ each: true })
    @Type(() => OrderItemInputDto)
    items: OrderItemInputDto[]
}
