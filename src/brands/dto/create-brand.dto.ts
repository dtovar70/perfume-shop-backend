import { Transform, Type, type TransformFnParams } from 'class-transformer'
import {
    IsBoolean,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUrl,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateIf,
} from 'class-validator'
import { SLUG_PATTERN } from '../../common/utils/text.util.js'
import { msg } from '../../common/validation/messages.js'
import { toBoolean } from '../../products/dto/query-transforms.js'
import {
    BRAND_DESCRIPTION_MAX_LENGTH,
    BRAND_FIELD as FIELD,
    BRAND_LOGO_URL_MAX_LENGTH,
    BRAND_NAME_MAX_LENGTH,
    BRAND_SLUG_MAX_LENGTH,
    BRAND_SORT_ORDER_MAX,
} from './field-names.js'

const trim = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value

/** A blank logo URL (e.g. an empty multipart field) removes the logo. */
const blankToNull = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' && value.trim() === '' ? null : trim({ value } as TransformFnParams)

/**
 * JSON or multipart/form-data (with an optional `logo` image, see AdminBrandsController). In a
 * multipart body every field arrives as text, hence the number and boolean conversions.
 */
export class CreateBrandDto {
    @Transform(trim)
    @IsString({ message: msg.text(FIELD.name) })
    @IsNotEmpty({ message: msg.required(FIELD.name) })
    @MaxLength(BRAND_NAME_MAX_LENGTH, { message: msg.maxLength(FIELD.name, BRAND_NAME_MAX_LENGTH) })
    name: string

    /** Generated from the name when omitted. It is the brand's URL and cannot change later. */
    @IsOptional()
    @Matches(SLUG_PATTERN, { message: 'El slug solo admite minúsculas, números y guiones.' })
    @MaxLength(BRAND_SLUG_MAX_LENGTH, {
        message: msg.maxLength(FIELD.slug, BRAND_SLUG_MAX_LENGTH),
    })
    slug?: string

    /** An external logo (https://…); null or blank removes it. An uploaded `logo` file wins. */
    @IsOptional()
    @Transform(blankToNull)
    @ValidateIf((_object, value) => value !== null)
    @MaxLength(BRAND_LOGO_URL_MAX_LENGTH, {
        message: msg.maxLength(FIELD.logoUrl, BRAND_LOGO_URL_MAX_LENGTH),
    })
    @IsUrl(
        { protocols: ['http', 'https'], require_protocol: true },
        { message: 'El logo debe ser una dirección web válida (https://…).' },
    )
    logoUrl?: string | null

    @IsOptional()
    @Transform(trim)
    @IsString({ message: msg.text(FIELD.description) })
    @MaxLength(BRAND_DESCRIPTION_MAX_LENGTH, {
        message: msg.maxLength(FIELD.description, BRAND_DESCRIPTION_MAX_LENGTH),
    })
    description?: string

    /** Position in lists (ascending). Defaults to after the last brand. */
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: msg.integer(FIELD.sortOrder) })
    @Min(0, { message: msg.notNegative(FIELD.sortOrder) })
    @Max(BRAND_SORT_ORDER_MAX, { message: msg.max(FIELD.sortOrder, BRAND_SORT_ORDER_MAX) })
    sortOrder?: number

    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean({ message: msg.boolean(FIELD.isActive) })
    isActive?: boolean
}
