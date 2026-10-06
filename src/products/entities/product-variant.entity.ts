import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryColumn,
    type Relation,
} from 'typeorm'
import { TEXT_INPUT_MAX_LENGTH } from '../../common/validation/text-limits.js'
import { decimalTransformer } from '../../database/decimal.transformer.js'
import { Product } from './product.entity.js'

@Entity({ name: 'product_variants' })
@Index('product_variants_product_id_idx', ['productId'])
@Check('product_variants_stock_check', `"stock" >= 0`)
@Check('product_variants_volume_ml_check', `"volume_ml" IS NULL OR "volume_ml" > 0`)
export class ProductVariant {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'product_variants_pkey' })
    id: string

    @Column({ name: 'product_id', type: 'text' })
    productId: string

    @ManyToOne(() => Product, (product) => product.variants, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({
        name: 'product_id',
        foreignKeyConstraintName: 'product_variants_product_id_fkey',
    })
    product: Relation<Product>

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    label: string

    @Column({
        name: 'price_delta',
        type: 'numeric',
        precision: 10,
        scale: 2,
        default: 0,
        transformer: decimalTransformer,
    })
    priceDelta: number

    /** Bottle size of this version ("50 ml"), when the variants are sizes. */
    @Column({ name: 'volume_ml', type: 'integer', nullable: true })
    volumeMl: number | null

    @Column({ name: 'sort_order', type: 'integer', default: 0 })
    sortOrder: number

    /** Units of this version in stock; `products.stock` holds their sum (see product-stock.ts). */
    @Column({ type: 'integer', default: 0 })
    stock: number
}
