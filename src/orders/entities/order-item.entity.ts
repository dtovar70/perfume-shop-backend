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
import { decimalTransformer } from '../../database/decimal.transformer.js'
import { Product } from '../../products/entities/product.entity.js'
import { Order } from './order.entity.js'

/**
 * One ordered line, stored as a snapshot: later product edits (name, price, photos, variants)
 * never change a past order. `product_id` is only kept to restore stock and link the admin to
 * the product; it becomes null if the product is deleted.
 */
@Entity({ name: 'order_items' })
@Index('order_items_order_id_idx', ['orderId'])
@Check('order_items_quantity_check', `"quantity" > 0`)
export class OrderItem {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'order_items_pkey' })
    id: string

    @Column({ name: 'order_id', type: 'text' })
    orderId: string

    @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
    @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'order_items_order_id_fkey' })
    order: Relation<Order>

    @Column({ name: 'product_id', type: 'text', nullable: true })
    productId: string | null

    @ManyToOne(() => Product, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'product_id', foreignKeyConstraintName: 'order_items_product_id_fkey' })
    product: Relation<Product> | null

    /** Variant ids change when a product's variants are replaced, so there is no foreign key. */
    @Column({ name: 'variant_id', type: 'text', nullable: true })
    variantId: string | null

    @Column({ name: 'product_name', type: 'text' })
    productName: string

    @Column({ name: 'product_slug', type: 'text' })
    productSlug: string

    @Column({ name: 'variant_label', type: 'text', nullable: true })
    variantLabel: string | null

    /** First product photo at order time; null when the product had none. */
    @Column({ name: 'image_url', type: 'text', nullable: true })
    imageUrl: string | null

    @Column({
        name: 'unit_price_usd',
        type: 'numeric',
        precision: 10,
        scale: 2,
        transformer: decimalTransformer,
    })
    unitPriceUsd: number

    @Column({ type: 'integer' })
    quantity: number

    @Column({
        name: 'line_total_usd',
        type: 'numeric',
        precision: 10,
        scale: 2,
        transformer: decimalTransformer,
    })
    lineTotalUsd: number

    @Column({ name: 'sort_order', type: 'integer', default: 0 })
    sortOrder: number
}
