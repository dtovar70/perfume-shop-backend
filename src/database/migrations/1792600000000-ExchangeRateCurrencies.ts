import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The business can convert with the BCV dollar, the BCV euro or the USDT Binance P2P rate:
 * - `exchange_rates.currency` ('USD' | 'EUR' | 'USDT'): every existing row is a dollar rate, so
 *   the column defaults to 'USD'. The newest-rate lookups are now per currency, so the
 *   `(fetched_at)` index becomes `(currency, fetched_at)`. `source` also accepts 'binance'.
 * - `orders.exchange_rate_currency`: the snapshot of which rate an order was priced with
 *   ('USD' for every existing order).
 * - `app_settings`: one row per business setting (jsonb value). The active currency lives under
 *   `exchange_rate_currency`; without a row it is 'USD', so nothing changes on deploy.
 *
 * `down()` deletes the euro and USDT rates (orders pointing at them keep their snapshot; the
 * foreign key sets `exchange_rate_id` to null) and drops the new columns and table: orders
 * priced with another currency then read as dollar orders.
 */
export class ExchangeRateCurrencies1792600000000 implements MigrationInterface {
    name = 'ExchangeRateCurrencies1792600000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "exchange_rates"
                ADD COLUMN "currency" text NOT NULL DEFAULT 'USD',
                ADD CONSTRAINT "exchange_rates_currency_check"
                    CHECK ("currency" IN ('USD', 'EUR', 'USDT')),
                DROP CONSTRAINT "exchange_rates_source_check",
                ADD CONSTRAINT "exchange_rates_source_check"
                    CHECK ("source" IN ('bcv', 'dolarapi', 'binance', 'manual'))
        `)
        await queryRunner.query(`DROP INDEX "exchange_rates_fetched_at_idx"`)
        await queryRunner.query(`
            CREATE INDEX "exchange_rates_currency_fetched_at_idx"
            ON "exchange_rates" ("currency", "fetched_at")
        `)
        await queryRunner.query(`
            ALTER TABLE "orders"
                ADD COLUMN "exchange_rate_currency" text NOT NULL DEFAULT 'USD',
                ADD CONSTRAINT "orders_exchange_rate_currency_check"
                    CHECK ("exchange_rate_currency" IN ('USD', 'EUR', 'USDT'))
        `)
        await queryRunner.query(`
            CREATE TABLE "app_settings" (
                "key" text NOT NULL,
                "value" jsonb NOT NULL,
                "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
                "updated_by" text,
                CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key"),
                CONSTRAINT "app_settings_updated_by_fkey" FOREIGN KEY ("updated_by")
                    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
            )
        `)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "app_settings"`)
        await queryRunner.query(`
            ALTER TABLE "orders"
                DROP CONSTRAINT "orders_exchange_rate_currency_check",
                DROP COLUMN "exchange_rate_currency"
        `)
        await queryRunner.query(`DELETE FROM "exchange_rates" WHERE "currency" <> 'USD'`)
        await queryRunner.query(`DROP INDEX "exchange_rates_currency_fetched_at_idx"`)
        await queryRunner.query(
            `CREATE INDEX "exchange_rates_fetched_at_idx" ON "exchange_rates" ("fetched_at")`,
        )
        await queryRunner.query(`
            ALTER TABLE "exchange_rates"
                DROP CONSTRAINT "exchange_rates_source_check",
                ADD CONSTRAINT "exchange_rates_source_check"
                    CHECK ("source" IN ('bcv', 'dolarapi', 'manual')),
                DROP CONSTRAINT "exchange_rates_currency_check",
                DROP COLUMN "currency"
        `)
    }
}
