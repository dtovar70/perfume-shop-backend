import {
    Check,
    Column,
    CreateDateColumn,
    Entity,
    OneToMany,
    PrimaryColumn,
    UpdateDateColumn,
    type Relation,
} from 'typeorm'
import { TEXT_INPUT_MAX_LENGTH } from '../../common/validation/text-limits.js'
import { Product } from '../../products/entities/product.entity.js'
import { BRAND_DESCRIPTION_MAX_LENGTH } from '../dto/field-names.js'

/** A perfume house ("Lattafa", "Dior"). Products point to it by slug. */
@Entity({ name: 'brands' })
@Check(
    'brands_description_length_check',
    `char_length("description") <= ${BRAND_DESCRIPTION_MAX_LENGTH}`,
)
export class Brand {
    @PrimaryColumn({
        type: 'varchar',
        length: TEXT_INPUT_MAX_LENGTH,
        primaryKeyConstraintName: 'brands_pkey',
    })
    slug: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    name: string

    @Column({ name: 'logo_url', type: 'text', nullable: true })
    logoUrl: string | null

    /** Storage key of an uploaded logo (to delete it later); null for a plain `logoUrl`. */
    @Column({ name: 'logo_public_id', type: 'text', nullable: true })
    logoPublicId: string | null

    @Column({ type: 'text', default: '' })
    description: string

    @Column({ name: 'sort_order', type: 'integer', default: 0 })
    sortOrder: number

    @Column({ name: 'is_active', type: 'boolean', default: true })
    isActive: boolean

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
    createdAt: Date

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', precision: 3 })
    updatedAt: Date

    @OneToMany(() => Product, (product) => product.brand)
    products: Relation<Product[]>
}
