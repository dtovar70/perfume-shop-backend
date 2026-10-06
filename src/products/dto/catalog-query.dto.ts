import { Transform, Type } from 'class-transformer'
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator'
import { SLUG_PATTERN } from '../../common/utils/text.util.js'
import { msg } from '../../common/validation/messages.js'
import {
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    PRODUCT_CONCENTRATIONS,
    PRODUCT_FAMILY_MAX_LENGTH,
    PRODUCT_GENDERS,
    PRODUCT_TAGS,
    RETIRED_SORT_OPTIONS,
    SORT_OPTIONS,
    type ProductConcentration,
    type ProductGender,
    type ProductTag,
    type SortOption,
} from '../products.constants.js'
import { FIELD } from './field-names.js'
import { toStringArray, toTrimmedString } from './query-transforms.js'

export class CatalogQueryDto {
    @IsOptional()
    @Matches(SLUG_PATTERN, { message: msg.invalid(FIELD.category) })
    category?: string

    @IsOptional()
    @Transform(toTrimmedString)
    @IsString({ message: msg.text(FIELD.search) })
    @MaxLength(100, { message: msg.maxLength(FIELD.search, 100) })
    search?: string

    @IsOptional()
    // An old bookmarked `?sort=rating` shows the default order instead of failing.
    @Transform(({ value }) =>
        typeof value === 'string' && RETIRED_SORT_OPTIONS.includes(value) ? 'relevance' : value,
    )
    @IsIn(SORT_OPTIONS, { message: 'El orden solicitado no es válido.' })
    sort: SortOption = 'relevance'

    @IsOptional()
    @Type(() => Number)
    @IsNumber({}, { message: msg.number(FIELD.minPrice) })
    @Min(0, { message: msg.notNegative(FIELD.minPrice) })
    minPrice?: number

    @IsOptional()
    @Type(() => Number)
    @IsNumber({}, { message: msg.number(FIELD.maxPrice) })
    @Min(0, { message: msg.notNegative(FIELD.maxPrice) })
    maxPrice?: number

    @IsOptional()
    @Transform(toStringArray)
    @IsArray({ message: msg.list(FIELD.tags) })
    @IsIn(PRODUCT_TAGS, { each: true, message: 'Alguna de las etiquetas no es válida.' })
    tags?: ProductTag[]

    /** Brand slugs: `?brand=lattafa&brand=armaf` or `?brand=lattafa,armaf` (any of them). */
    @IsOptional()
    @Transform(toStringArray)
    @IsArray({ message: msg.list(FIELD.brands) })
    @ArrayMaxSize(20, { message: msg.listMaxSize(FIELD.brands, 20) })
    @Matches(SLUG_PATTERN, { each: true, message: 'Alguna de las marcas no es válida.' })
    brand?: string[]

    @IsOptional()
    @IsIn(PRODUCT_GENDERS, { message: msg.invalid(FIELD.gender) })
    gender?: ProductGender

    @IsOptional()
    @IsIn(PRODUCT_CONCENTRATIONS, { message: msg.invalid(FIELD.concentration) })
    concentration?: ProductConcentration

    /** Olfactory family ("Oriental"), compared ignoring case. */
    @IsOptional()
    @Transform(toTrimmedString)
    @IsString({ message: msg.text(FIELD.olfactoryFamily) })
    @MaxLength(PRODUCT_FAMILY_MAX_LENGTH, {
        message: msg.maxLength(FIELD.olfactoryFamily, PRODUCT_FAMILY_MAX_LENGTH),
    })
    family?: string

    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: msg.integer(FIELD.page) })
    @Min(1, { message: msg.min(FIELD.page, 1) })
    page: number = 1

    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: msg.integer(FIELD.pageSize) })
    @Min(1, { message: msg.min(FIELD.pageSize, 1) })
    @Max(MAX_PAGE_SIZE, { message: msg.max(FIELD.pageSize, MAX_PAGE_SIZE) })
    pageSize: number = DEFAULT_PAGE_SIZE
}

/** `GET /products/facets`: optionally scoped to one category. */
export class FacetsQueryDto {
    @IsOptional()
    @Matches(SLUG_PATTERN, { message: msg.invalid(FIELD.category) })
    category?: string
}
