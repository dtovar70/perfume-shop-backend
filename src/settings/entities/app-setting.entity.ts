import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm'
import { User } from '../../auth/entities/user.entity.js'

/** Every key of `app_settings`, with the value it holds. */
export interface AppSettings {
    /** The rate checkout converts with (see ExchangeRateService). */
    exchange_rate_currency: string
}
export type AppSettingKey = keyof AppSettings

/**
 * Business settings an admin can change at any time (one row per key). A key without a row
 * means its built-in default, so a fresh database behaves like before the setting existed.
 */
@Entity({ name: 'app_settings' })
export class AppSetting {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'app_settings_pkey' })
    key: AppSettingKey

    @Column({ type: 'jsonb' })
    value: unknown

    @Column({ name: 'updated_at', type: 'timestamptz', precision: 3, default: () => 'now()' })
    updatedAt: Date

    /** Kept when the user is deleted (the column becomes null). */
    @Column({ name: 'updated_by', type: 'text', nullable: true })
    updatedById: string | null

    @ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'updated_by', foreignKeyConstraintName: 'app_settings_updated_by_fkey' })
    updatedBy: Relation<User> | null
}
