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
import { User } from '../../auth/entities/user.entity.js'
import { decimalTransformer } from '../../database/decimal.transformer.js'
import type { RateSource } from '../providers/rate-provider.js'
import { RATE_CURRENCIES, type RateCurrency } from '../rate-currency.js'

/**
 * Bolívar rates per currency (BCV dollar, BCV euro, USDT on Binance), newest last. A row is
 * added when a provider reports a rate that differs from the last automatic one of its currency,
 * or when an admin sets one by hand. Checkout uses the newest row of the business's active
 * currency (see ExchangeRateService).
 */

@Entity({ name: 'exchange_rates' })
@Index('exchange_rates_currency_fetched_at_idx', ['currency', 'fetchedAt'])
@Check('exchange_rates_rate_check', `"rate" > 0`)
@Check('exchange_rates_source_check', `"source" IN ('bcv', 'dolarapi', 'binance', 'manual')`)
@Check(
    'exchange_rates_currency_check',
    `"currency" IN (${RATE_CURRENCIES.map((currency) => `'${currency}'`).join(', ')})`,
)
export class ExchangeRate {
    @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'exchange_rates_pkey' })
    id: string

    /** What one unit of `rate` is: rows before the choice existed are all 'USD'. */
    @Column({ type: 'text', default: 'USD' })
    currency: RateCurrency

    /** Bolívares per unit of `currency`. */
    @Column({ type: 'numeric', precision: 12, scale: 4, transformer: decimalTransformer })
    rate: number

    @Column({ type: 'text' })
    source: RateSource

    /** BCV "fecha valor" ("YYYY-MM-DD"): the business day the rate applies to. */
    @Column({ name: 'effective_date', type: 'date' })
    effectiveDate: string

    /** When the rate was read from its source (or set by hand). */
    @Column({ name: 'fetched_at', type: 'timestamptz', precision: 3 })
    fetchedAt: Date

    @Column({ name: 'is_manual', type: 'boolean', default: false })
    isManual: boolean

    /** Admin who set a manual rate; null for automatic ones (or when the user is deleted). */
    @Column({ name: 'created_by', type: 'text', nullable: true })
    createdById: string | null

    @ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'created_by', foreignKeyConstraintName: 'exchange_rates_created_by_fkey' })
    createdBy: Relation<User> | null
}
