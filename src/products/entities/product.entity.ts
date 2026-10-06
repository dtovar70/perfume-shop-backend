import {
    Check,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryColumn,
    UpdateDateColumn,
    type Relation,
} from 'typeorm'
import { TEXT_INPUT_MAX_LENGTH } from '../../common/validation/text-limits.js'
import {
    PRODUCT_CONCENTRATIONS,
    PRODUCT_DESCRIPTION_MAX_LENGTH,
    PRODUCT_GENDERS,
    PRODUCT_MAX_HIGHLIGHTS,
    PRODUCT_MAX_NOTES,
    type ProductConcentration,
    type ProductGender,
} from '../products.constants.js'
import { Brand } from '../../brands/entities/brand.entity.js'
import { Category } from '../../categories/entities/category.entity.js'
import { decimalTransformer } from '../../database/decimal.transformer.js'
import { ProductImage } from './product-image.entity.js'
import { ProductVariant } from './product-variant.entity.js'

@Entity({ name: 'products' })
@Index('products_slug_key', ['slug'], { unique: true })
@Index('products_category_slug_idx', ['categorySlug'])
@Index('products_brand_slug_idx', ['brandSlug'])
@Index('products_sku_key', ['sku'], { unique: true })
@Index('products_is_active_relevance_score_idx', ['isActive', 'relevanceScore'])
@Check(
    'products_description_length_check',
    `char_length("description") <= ${PRODUCT_DESCRIPTION_MAX_LENGTH}`,
)
@Check('products_highlights_count_check', `cardinality("highlights") <= ${PRODUCT_MAX_HIGHLIGHTS}`)
/** `max_text_array_item_length(text[])` is created by the TextLengthLimits migration. */
@Check(
    'products_highlights_length_check',
    `max_text_array_item_length("highlights") <= ${TEXT_INPUT_MAX_LENGTH}`,
)
@Check(
    'products_gender_check',
    `"gender" IN (${PRODUCT_GENDERS.map((value) => `'${value}'`).join(', ')})`,
)
@Check(
    'products_concentration_check',
    `"concentration" IS NULL OR "concentration" IN (${PRODUCT_CONCENTRATIONS.map((value) => `'${value}'`).join(', ')})`,
)
@Check('products_volume_ml_check', `"volume_ml" IS NULL OR "volume_ml" > 0`)
@Check(
    'products_notes_count_check',
    `cardinality("notes_top") <= ${PRODUCT_MAX_NOTES} AND cardinality("notes_heart") <= ${PRODUCT_MAX_NOTES} AND cardinality("notes_base") <= ${PRODUCT_MAX_NOTES}`,
)
export class Product {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'products_pkey' })
    id: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    slug: string

    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    name: string

    @Column({ name: 'category_slug', type: 'varchar', length: TEXT_INPUT_MAX_LENGTH })
    categorySlug: string

    @ManyToOne(() => Category, (category) => category.products, {
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({
        name: 'category_slug',
        referencedColumnName: 'slug',
        foreignKeyConstraintName: 'products_category_slug_fkey',
    })
    category: Relation<Category>

    /** Perfume house; null for a product without one. */
    @Column({ name: 'brand_slug', type: 'varchar', length: TEXT_INPUT_MAX_LENGTH, nullable: true })
    brandSlug: string | null

    @ManyToOne(() => Brand, (brand) => brand.products, {
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        nullable: true,
    })
    @JoinColumn({
        name: 'brand_slug',
        referencedColumnName: 'slug',
        foreignKeyConstraintName: 'products_brand_slug_fkey',
    })
    brand: Relation<Brand> | null

    @Column({ type: 'varchar', length: 16, default: 'unisex' })
    gender: ProductGender

    @Column({ type: 'varchar', length: 16, nullable: true })
    concentration: ProductConcentration | null

    /** Bottle size of the base product, in ml. */
    @Column({ name: 'volume_ml', type: 'integer', nullable: true })
    volumeMl: number | null

    /** Olfactory pyramid: top (salida), heart (corazón) and base (fondo) notes. */
    @Column({ name: 'notes_top', type: 'text', array: true, default: () => "'{}'" })
    notesTop: string[]

    @Column({ name: 'notes_heart', type: 'text', array: true, default: () => "'{}'" })
    notesHeart: string[]

    @Column({ name: 'notes_base', type: 'text', array: true, default: () => "'{}'" })
    notesBase: string[]

    /** "Oriental", "Amaderada", "Floral"… Free text, used as a catalog filter. */
    @Column({
        name: 'olfactory_family',
        type: 'varchar',
        length: TEXT_INPUT_MAX_LENGTH,
        nullable: true,
    })
    olfactoryFamily: string | null

    /** Shown first on the home page (`GET /products/featured`) and boosts relevance. */
    @Column({ name: 'is_featured', type: 'boolean', default: false })
    isFeatured: boolean

    /** Internal stock code ("KZ-0001"); unique when set. */
    @Column({ type: 'varchar', length: TEXT_INPUT_MAX_LENGTH, nullable: true })
    sku: string | null

    @Column({ type: 'numeric', precision: 10, scale: 2, transformer: decimalTransformer })
    price: number

    @Column({
        name: 'compare_at_price',
        type: 'numeric',
        precision: 10,
        scale: 2,
        nullable: true,
        transformer: decimalTransformer,
    })
    compareAtPrice: number | null

    @Column({ type: 'text' })
    description: string

    @Column({ type: 'text', array: true, default: () => "'{}'" })
    highlights: string[]

    /** Allowed values: nuevo, bestseller, oferta (validated in the API layer). */
    @Column({ type: 'text', array: true, default: () => "'{}'" })
    tags: string[]

    /** Legacy seed data: the shop has no reviews, so this is neither exposed nor ranked on. */
    @Column({ type: 'double precision', default: 0 })
    rating: number

    /** Legacy seed data, see `rating`. */
    @Column({ name: 'review_count', type: 'integer', default: 0 })
    reviewCount: number

    /**
     * Units in stock. With variants it is derived: the sum of `product_variants.stock`, kept in
     * sync inside the same transaction that changes them (see product-stock.ts). Only products
     * without variants hold their own count here.
     */
    @Column({ type: 'integer', default: 0 })
    stock: number

    @Column({ name: 'is_active', type: 'boolean', default: true })
    isActive: boolean

    /**
     * Derived: lowercased, accent-stripped name, description, brand, gender, concentration,
     * family, notes and tags for search (see product-derived.ts).
     */
    @Column({ name: 'search_text', type: 'text', default: '' })
    searchText: string

    /** Derived: featured(+20) + bestseller(+10) + nuevo(+4). Backs the "relevance" sort. */
    @Column({ name: 'relevance_score', type: 'double precision', default: 0 })
    relevanceScore: number

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
    createdAt: Date

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', precision: 3 })
    updatedAt: Date

    @OneToMany(() => ProductVariant, (variant) => variant.product)
    variants: Relation<ProductVariant[]>

    @OneToMany(() => ProductImage, (image) => image.product)
    images: Relation<ProductImage[]>
}
