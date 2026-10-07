import { Transform, type TransformFnParams } from 'class-transformer'
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
import { HEX_COLOR_PATTERN, SLUG_PATTERN } from '../../common/utils/text.util.js'
import { msg } from '../../common/validation/messages.js'
import { MaxInputLength } from '../../common/validation/text-limits.js'
import { toBoolean } from '../../products/dto/query-transforms.js'
import {
    CATEGORY_DESCRIPTION_MAX_LENGTH,
    CATEGORY_FIELD as FIELD,
    CATEGORY_IMAGE_URL_MAX_LENGTH,
    CATEGORY_NAME_MAX_LENGTH,
    CATEGORY_SLUG_MAX_LENGTH,
    CATEGORY_SORT_ORDER_MAX,
    CATEGORY_TAGLINE_MAX_LENGTH,
} from './field-names.js'

/** A blank cover URL (e.g. an empty multipart field) removes the cover. */
const blankToNull = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value

/** A multipart field is text: "3" becomes 3 (anything else is left for `@IsInt` to refuse). */
const numericText = ({ value }: TransformFnParams): unknown =>
    typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value

/**
 * JSON or multipart/form-data (with an optional `image` file, see AdminCategoriesController). In
 * a multipart body every field arrives as text, hence the number and boolean conversions.
 */
export class CreateCategoryDto {
    @IsString({ message: msg.text(FIELD.name) })
    @IsNotEmpty({ message: msg.required(FIELD.name) })
    @MaxLength(CATEGORY_NAME_MAX_LENGTH, {
        message: msg.maxLength(FIELD.name, CATEGORY_NAME_MAX_LENGTH),
    })
    name: string

    /** Generated from the name when omitted. It is the category's URL and cannot change later. */
    @IsOptional()
    @Matches(SLUG_PATTERN, { message: 'El slug solo admite minúsculas, números y guiones.' })
    @MaxLength(CATEGORY_SLUG_MAX_LENGTH, {
        message: msg.maxLength(FIELD.slug, CATEGORY_SLUG_MAX_LENGTH),
    })
    slug?: string

    @IsOptional()
    @IsString({ message: msg.text(FIELD.tagline) })
    @MaxLength(CATEGORY_TAGLINE_MAX_LENGTH, {
        message: msg.maxLength(FIELD.tagline, CATEGORY_TAGLINE_MAX_LENGTH),
    })
    tagline?: string

    @IsOptional()
    @IsString({ message: msg.text(FIELD.description) })
    @MaxLength(CATEGORY_DESCRIPTION_MAX_LENGTH, {
        message: msg.maxLength(FIELD.description, CATEGORY_DESCRIPTION_MAX_LENGTH),
    })
    description?: string

    @MaxInputLength(FIELD.color)
    @Matches(HEX_COLOR_PATTERN, { message: msg.hexColor(FIELD.color) })
    colorHex: string

    /** Position in menus and lists (ascending). Defaults to after the last category. */
    @IsOptional()
    @Transform(numericText)
    @IsInt({ message: msg.integer(FIELD.sortOrder) })
    @Min(0, { message: msg.notNegative(FIELD.sortOrder) })
    @Max(CATEGORY_SORT_ORDER_MAX, { message: msg.max(FIELD.sortOrder, CATEGORY_SORT_ORDER_MAX) })
    sortOrder?: number

    /** An external cover (https://…); null or blank removes it. An uploaded `image` file wins. */
    @IsOptional()
    @Transform(blankToNull)
    @ValidateIf((_object, value) => value !== null)
    @MaxLength(CATEGORY_IMAGE_URL_MAX_LENGTH, {
        message: msg.maxLength(FIELD.imageUrl, CATEGORY_IMAGE_URL_MAX_LENGTH),
    })
    @IsUrl(
        { protocols: ['http', 'https'], require_protocol: true },
        { message: 'La imagen de portada debe ser una dirección web válida (https://…).' },
    )
    imageUrl?: string | null

    /** `true` removes the current cover (same as `imageUrl: null`). An uploaded file wins. */
    @IsOptional()
    @Transform(toBoolean)
    @IsBoolean({ message: msg.boolean(FIELD.removeImage) })
    removeImage?: boolean
}
