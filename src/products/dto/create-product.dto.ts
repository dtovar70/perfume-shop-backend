import { applyDecorators } from '@nestjs/common'
import { Type } from 'class-transformer'
import {
    ArrayMaxSize,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator'
import { SLUG_PATTERN } from '../../common/utils/text.util.js'
import { msg } from '../../common/validation/messages.js'
import { MaxInputLength, TEXT_INPUT_MAX_LENGTH } from '../../common/validation/text-limits.js'
import {
    PRODUCT_CONCENTRATIONS,
    PRODUCT_DESCRIPTION_MAX_LENGTH,
    PRODUCT_FAMILY_MAX_LENGTH,
    PRODUCT_GENDERS,
    PRODUCT_MAX_HIGHLIGHTS,
    PRODUCT_MAX_NOTES,
    PRODUCT_MAX_VOLUME_ML,
    PRODUCT_NOTE_MAX_LENGTH,
    PRODUCT_SKU_MAX_LENGTH,
    PRODUCT_TAGS,
    type ProductConcentration,
    type ProductGender,
    type ProductTag,
} from '../products.constants.js'
import { FIELD } from './field-names.js'

const MAX_PRICE = 99_999_999.99
/** A typo never overflows the `integer` columns, not even summed over every variant. */
const MAX_STOCK = 1_000_000

/** "KZ-0001": letters, digits, dots, dashes and underscores. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One tier of the olfactory pyramid: a list of short single-line notes. */
function NotesList(field: (typeof FIELD)['notesTop']): PropertyDecorator {
    return applyDecorators(
        IsOptional(),
        IsArray({ message: msg.list(field) }),
        ArrayMaxSize(PRODUCT_MAX_NOTES, { message: msg.listMaxSize(field, PRODUCT_MAX_NOTES) }),
        IsString({ each: true, message: 'Cada nota debe ser un texto.' }),
        IsNotEmpty({ each: true, message: 'Ninguna nota puede estar vacía.' }),
        MaxLength(PRODUCT_NOTE_MAX_LENGTH, {
            each: true,
            message: `Cada nota no puede superar los ${PRODUCT_NOTE_MAX_LENGTH} caracteres.`,
        }),
    )
}

export class ProductVariantInputDto {
    /**
     * An existing variant of this product keeps its id (orders and carts point to it); omit it
     * for a new variant. Unknown ids get a new one.
     */
    @IsOptional()
    @IsString({ message: msg.text(FIELD.variantId) })
    @MaxLength(80, { message: msg.maxLength(FIELD.variantId, 80) })
    id?: string

    @IsString({ message: msg.text(FIELD.variantLabel) })
    @IsNotEmpty({ message: msg.required(FIELD.variantLabel) })
    @MaxLength(80, { message: msg.maxLength(FIELD.variantLabel, 80) })
    label: string

    @IsNumber({ maxDecimalPlaces: 2 }, { message: msg.money(FIELD.variantPriceDelta) })
    @Min(-MAX_PRICE, { message: msg.min(FIELD.variantPriceDelta, -MAX_PRICE) })
    @Max(MAX_PRICE, { message: msg.max(FIELD.variantPriceDelta, MAX_PRICE) })
    priceDelta: number

    /** Bottle size of this version ("50 ml"); omit or null when the variant is not a size. */
    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @IsInt({ message: msg.integer(FIELD.variantVolumeMl) })
    @Min(1, { message: msg.min(FIELD.variantVolumeMl, 1) })
    @Max(PRODUCT_MAX_VOLUME_ML, { message: msg.max(FIELD.variantVolumeMl, PRODUCT_MAX_VOLUME_ML) })
    volumeMl?: number | null

    @IsInt({ message: msg.integer(FIELD.variantStock) })
    @Min(0, { message: msg.notNegative(FIELD.variantStock) })
    @Max(MAX_STOCK, { message: msg.max(FIELD.variantStock, MAX_STOCK) })
    stock: number
}

export class CreateProductDto {
    /** Generated from the name when omitted. */
    @IsOptional()
    @Matches(SLUG_PATTERN, { message: 'El slug solo admite minúsculas, números y guiones.' })
    @MaxLength(80, { message: msg.maxLength(FIELD.slug, 80) })
    slug?: string

    @IsString({ message: msg.text(FIELD.name) })
    @IsNotEmpty({ message: msg.required(FIELD.name) })
    @MaxInputLength(FIELD.name)
    name: string

    @Matches(SLUG_PATTERN, { message: msg.invalid(FIELD.category) })
    categorySlug: string

    @IsNumber({ maxDecimalPlaces: 2 }, { message: msg.money(FIELD.price) })
    @Min(0, { message: msg.notNegative(FIELD.price) })
    @Max(MAX_PRICE, { message: msg.max(FIELD.price, MAX_PRICE) })
    price: number

    /** Send null to remove the "before" price. */
    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @IsNumber({ maxDecimalPlaces: 2 }, { message: msg.money(FIELD.compareAtPrice) })
    @Min(0, { message: msg.notNegative(FIELD.compareAtPrice) })
    @Max(MAX_PRICE, { message: msg.max(FIELD.compareAtPrice, MAX_PRICE) })
    compareAtPrice?: number | null

    /** The perfume house; send null to remove it. */
    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @Matches(SLUG_PATTERN, { message: msg.invalid(FIELD.brand) })
    brandSlug?: string | null

    /** `unisex` when omitted on create. */
    @IsOptional()
    @IsIn(PRODUCT_GENDERS, { message: msg.invalid(FIELD.gender) })
    gender?: ProductGender

    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @IsIn(PRODUCT_CONCENTRATIONS, { message: msg.invalid(FIELD.concentration) })
    concentration?: ProductConcentration | null

    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @IsInt({ message: msg.integer(FIELD.volumeMl) })
    @Min(1, { message: msg.min(FIELD.volumeMl, 1) })
    @Max(PRODUCT_MAX_VOLUME_ML, { message: msg.max(FIELD.volumeMl, PRODUCT_MAX_VOLUME_ML) })
    volumeMl?: number | null

    /** Top notes ("notas de salida"). */
    @NotesList(FIELD.notesTop)
    notesTop?: string[]

    /** Heart notes ("notas de corazón"). */
    @NotesList(FIELD.notesHeart)
    notesHeart?: string[]

    /** Base notes ("notas de fondo"). */
    @NotesList(FIELD.notesBase)
    notesBase?: string[]

    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @IsString({ message: msg.text(FIELD.olfactoryFamily) })
    @IsNotEmpty({ message: msg.required(FIELD.olfactoryFamily) })
    @MaxLength(PRODUCT_FAMILY_MAX_LENGTH, {
        message: msg.maxLength(FIELD.olfactoryFamily, PRODUCT_FAMILY_MAX_LENGTH),
    })
    olfactoryFamily?: string | null

    @IsOptional()
    @IsBoolean({ message: msg.boolean(FIELD.isFeatured) })
    isFeatured?: boolean

    /** Internal stock code, unique when set; send null to remove it. */
    @IsOptional()
    @ValidateIf((_object, value) => value !== null)
    @MaxLength(PRODUCT_SKU_MAX_LENGTH, {
        message: msg.maxLength(FIELD.sku, PRODUCT_SKU_MAX_LENGTH),
    })
    @Matches(SKU_PATTERN, {
        message: 'El SKU solo admite letras, números, puntos, guiones y guiones bajos.',
    })
    sku?: string | null

    @IsString({ message: msg.text(FIELD.description) })
    @MaxLength(PRODUCT_DESCRIPTION_MAX_LENGTH, {
        message: msg.maxLength(FIELD.description, PRODUCT_DESCRIPTION_MAX_LENGTH),
    })
    description: string

    @IsOptional()
    @IsArray({ message: msg.list(FIELD.highlights) })
    @ArrayMaxSize(PRODUCT_MAX_HIGHLIGHTS, {
        message: msg.listMaxSize(FIELD.highlights, PRODUCT_MAX_HIGHLIGHTS),
    })
    @IsString({ each: true, message: 'Cada destacado debe ser un texto.' })
    @MaxLength(TEXT_INPUT_MAX_LENGTH, {
        each: true,
        message: `Cada destacado no puede superar los ${TEXT_INPUT_MAX_LENGTH} caracteres.`,
    })
    highlights?: string[]

    @IsOptional()
    @IsArray({ message: msg.list(FIELD.tags) })
    @ArrayUnique({ message: msg.listUnique(FIELD.tags) })
    @IsIn(PRODUCT_TAGS, { each: true, message: 'Alguna de las etiquetas no es válida.' })
    tags?: ProductTag[]

    @IsOptional()
    @IsNumber({ maxDecimalPlaces: 2 }, { message: msg.money(FIELD.rating) })
    @Min(0, { message: msg.notNegative(FIELD.rating) })
    @Max(5, { message: msg.max(FIELD.rating, 5) })
    rating?: number

    @IsOptional()
    @IsInt({ message: msg.integer(FIELD.reviewCount) })
    @Min(0, { message: msg.notNegative(FIELD.reviewCount) })
    reviewCount?: number

    /**
     * Only for a product without variants (0 when omitted). With variants the product's stock
     * is the sum of theirs, so this value is ignored.
     */
    @IsOptional()
    @IsInt({ message: msg.integer(FIELD.stock) })
    @Min(0, { message: msg.notNegative(FIELD.stock) })
    @Max(MAX_STOCK, { message: msg.max(FIELD.stock, MAX_STOCK) })
    stock?: number

    @IsOptional()
    @IsBoolean({ message: msg.boolean(FIELD.isActive) })
    isActive?: boolean

    /** On update, when present, replaces the full variant list (order = array order). */
    @IsOptional()
    @IsArray({ message: msg.list(FIELD.variants) })
    @ArrayMaxSize(30, { message: msg.listMaxSize(FIELD.variants, 30) })
    @ValidateNested({ each: true, message: 'Cada variante debe ser un objeto.' })
    @Type(() => ProductVariantInputDto)
    variants?: ProductVariantInputDto[]
}
