import { Transform, type TransformFnParams } from 'class-transformer'
import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator'
import { msg } from '../../common/validation/messages.js'
import { ORDER_CODE_PATTERN, ORDER_FIELD as FIELD, ORDER_LIMITS as LIMITS } from './field-names.js'

/** `?t=<token>` of the customer's private order link. Checked in the service (404 on mismatch). */
export class OrderAccessQueryDto {
    @IsOptional()
    @IsString()
    t?: string
}

const trim = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value

const trimUpper = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value

/** `POST /orders/lookup` ("Consultar mi pedido"): the order code and the checkout email. */
export class OrderLookupDto {
    @Transform(trimUpper)
    @IsString({ message: msg.text(FIELD.code) })
    @Matches(ORDER_CODE_PATTERN, { message: msg.format(FIELD.code, 'KZ-000123') })
    code: string

    @Transform(trim)
    @IsString({ message: msg.text(FIELD.email) })
    @IsEmail({}, { message: msg.email(FIELD.email) })
    @MaxLength(LIMITS.email, { message: msg.maxLength(FIELD.email, LIMITS.email) })
    email: string
}
