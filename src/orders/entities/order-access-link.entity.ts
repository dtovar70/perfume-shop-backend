import {
    Check,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryColumn,
    type Relation,
} from 'typeorm'
import { User } from '../../auth/entities/user.entity.js'
import { Order } from './order.entity.js'

/**
 * One private link to the customer's order page (`/pedido/KZ-000123?t=<token>`). Checkout creates
 * the first one; the admin issues more (e.g. for a WhatsApp message), because the token itself is
 * never stored and so an old link cannot be rebuilt. Only the SHA-256 (hex) of each token is
 * kept. Every link that is not revoked opens the order.
 */
@Entity({ name: 'order_access_links' })
@Index('order_access_links_token_hash_key', ['tokenHash'], { unique: true })
@Index('order_access_links_order_id_idx', ['orderId'])
@Check('order_access_links_token_hash_check', `"token_hash" ~ '^[a-f0-9]{64}$'`)
export class OrderAccessLink {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'order_access_links_pkey' })
    id: string

    @Column({ name: 'order_id', type: 'text' })
    orderId: string

    @ManyToOne(() => Order, (order) => order.accessLinks, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'order_access_links_order_id_fkey' })
    order: Relation<Order>

    /** SHA-256 (hex) of the token; the token itself is never stored. */
    @Column({ name: 'token_hash', type: 'text', select: false })
    tokenHash: string

    /** The admin who issued it; null for the checkout and emailed links (or a deleted user). */
    @Column({ name: 'created_by', type: 'text', nullable: true })
    createdById: string | null

    @ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({
        name: 'created_by',
        foreignKeyConstraintName: 'order_access_links_created_by_fkey',
    })
    createdBy: Relation<User> | null

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
    createdAt: Date

    /** Set when the link stops working. Nothing revokes links yet; the column is ready for it. */
    @Column({ name: 'revoked_at', type: 'timestamptz', precision: 3, nullable: true })
    revokedAt: Date | null
}
