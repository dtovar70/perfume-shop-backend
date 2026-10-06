import { Check, Column, Entity, OneToMany, PrimaryColumn, type Relation } from 'typeorm'
import { TEXT_INPUT_MAX_LENGTH } from '../../common/validation/text-limits.js'
import { CATEGORY_DESCRIPTION_MAX_LENGTH } from '../dto/field-names.js'
import { Product } from '../../products/entities/product.entity.js'

@Entity({ name: 'categories' })
@Check(
    'categories_description_length_check',
    `char_length("description") <= ${CATEGORY_DESCRIPTION_MAX_LENGTH}`,
)
export class Category {
    @PrimaryColumn({
        type: 'varchar',
        length: TEXT_INPUT_MAX_LENGTH,
        primaryKeyConstraintName: 'categories_pkey',
    })
    slug: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    name: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    tagline: string

    @Column({ type: 'text' })
    description: string

    @Column({ name: 'color_hex', type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    colorHex: string

    @Column({ name: 'sort_order', type: 'integer', default: 0 })
    sortOrder: number

    @OneToMany(() => Product, (product) => product.category)
    products: Relation<Product[]>
}
