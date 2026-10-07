import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Indexes for the three hot lookups that scanned whole tables:
 * - the catalog search (`products.search_text LIKE '%term%'`): a trigram GIN index is the only
 *   index Postgres can use for a leading-wildcard LIKE (needs the `pg_trgm` extension);
 * - the expiry job (`status = 'PENDIENTE_PAGO' AND payment_due_at < now()`, oldest first): a
 *   partial index holds only the unpaid orders, so it stays small however many orders exist;
 * - the duplicate-reference check on a new payment (`RIGHT("reference", 6) = $1`): an expression
 *   index matching that exact expression (see `OrdersService.findDuplicateReferences`).
 *
 * Built inside the migration transaction (not CONCURRENTLY): the tables are small, so the short
 * write lock is acceptable and a failure rolls back cleanly.
 */
export class QueryIndexes1792300000000 implements MigrationInterface {
    name = 'QueryIndexes1792300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "products_search_text_trgm_idx"
            ON "products" USING gin ("search_text" gin_trgm_ops)
        `)
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "orders_pending_payment_due_at_idx"
            ON "orders" ("payment_due_at") WHERE "status" = 'PENDIENTE_PAGO'
        `)
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "order_payments_reference_tail_idx"
            ON "order_payments" (RIGHT("reference", 6))
        `)
    }

    /**
     * Drops the indexes but keeps `pg_trgm`: the extension is database-wide, other objects (or a
     * DBA) may rely on it, and leaving it installed is harmless.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "order_payments_reference_tail_idx"`)
        await queryRunner.query(`DROP INDEX IF EXISTS "orders_pending_payment_due_at_idx"`)
        await queryRunner.query(`DROP INDEX IF EXISTS "products_search_text_trgm_idx"`)
    }
}
