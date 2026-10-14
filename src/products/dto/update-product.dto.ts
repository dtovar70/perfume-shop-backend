import { PartialType } from '@nestjs/mapped-types'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { msg } from '../../common/validation/messages.js'
import { CreateProductDto, MAX_STOCK } from './create-product.dto.js'
import { FIELD } from './field-names.js'

export class UpdateProductDto extends PartialType(CreateProductDto) {
    /**
     * The stock of a product without variants when the form was loaded: required to change
     * `stock`, which fails with 409 `STOCK_CHANGED` when the database no longer has this count.
     * When `stock` equals it the current count is kept. Variants send their own `expectedStock`.
     */
    @IsOptional()
    @IsInt({ message: msg.integer(FIELD.expectedStock) })
    @Min(0, { message: msg.notNegative(FIELD.expectedStock) })
    @Max(MAX_STOCK, { message: msg.max(FIELD.expectedStock, MAX_STOCK) })
    expectedStock?: number
}
