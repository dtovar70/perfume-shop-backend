import type { MigrationInterface, QueryRunner } from 'typeorm'

const ORDER_STATUSES = [
    'PENDIENTE_PAGO',
    'PENDIENTE_VERIFICACION',
    'PAGO_VERIFICADO',
    'PAGO_RECHAZADO',
    'EN_PRODUCCION',
    'LISTO_PARA_ENTREGA',
    'ENVIADO',
    'ENTREGADO',
    'CANCELADO',
    'EXPIRADO',
]
    .map((status) => `'${status}'`)
    .join(', ')

/**
 * Phase 3: BCV exchange rates, guest orders (items as snapshots), Pago Móvil payment proofs,
 * status history and internal notes. Order codes (a prefix plus six digits) come from `order_code_seq`.
 */
export class OrdersAndExchangeRates1790300000000 implements MigrationInterface {
    name = 'OrdersAndExchangeRates1790300000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "exchange_rates" (
                "id" text NOT NULL,
                "rate" numeric(12,4) NOT NULL,
                "source" text NOT NULL,
                "effective_date" date NOT NULL,
                "fetched_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
                "is_manual" boolean NOT NULL DEFAULT false,
                "created_by" text,
                CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "exchange_rates_rate_check" CHECK ("rate" > 0),
                CONSTRAINT "exchange_rates_source_check"
                    CHECK ("source" IN ('bcv', 'dolarapi', 'manual'))
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "exchange_rates_fetched_at_idx" ON "exchange_rates" ("fetched_at")`,
        )
        await queryRunner.query(`
            ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_created_by_fkey"
            FOREIGN KEY ("created_by") REFERENCES "users" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `)

        await queryRunner.query(`CREATE SEQUENCE "order_code_seq" AS integer START 1`)
        await queryRunner.query(`
            CREATE TABLE "orders" (
                "id" text NOT NULL,
                "code" text NOT NULL,
                "status" text NOT NULL,
                "access_token_hash" text NOT NULL,
                "customer_name" text NOT NULL,
                "customer_email" text NOT NULL,
                "customer_phone" text NOT NULL,
                "city" text NOT NULL,
                "address" text NOT NULL,
                "delivery_method" text NOT NULL,
                "notes" text NOT NULL DEFAULT '',
                "subtotal_usd" numeric(10,2) NOT NULL,
                "shipping_usd" numeric(10,2) NOT NULL,
                "total_usd" numeric(10,2) NOT NULL,
                "exchange_rate" numeric(12,4) NOT NULL,
                "exchange_rate_source" text NOT NULL,
                "exchange_rate_date" date NOT NULL,
                "exchange_rate_id" text,
                "total_bs" numeric(14,2) NOT NULL,
                "payment_due_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
                "stock_restored" boolean NOT NULL DEFAULT false,
                "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "orders_status_check" CHECK ("status" IN (${ORDER_STATUSES})),
                CONSTRAINT "orders_delivery_method_check"
                    CHECK ("delivery_method" IN ('delivery', 'pickup'))
            )
        `)
        await queryRunner.query(`CREATE UNIQUE INDEX "orders_code_key" ON "orders" ("code")`)
        await queryRunner.query(`CREATE INDEX "orders_status_idx" ON "orders" ("status")`)
        await queryRunner.query(`CREATE INDEX "orders_created_at_idx" ON "orders" ("created_at")`)
        await queryRunner.query(`
            ALTER TABLE "orders" ADD CONSTRAINT "orders_exchange_rate_id_fkey"
            FOREIGN KEY ("exchange_rate_id") REFERENCES "exchange_rates" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `)

        await queryRunner.query(`
            CREATE TABLE "order_items" (
                "id" text NOT NULL,
                "order_id" text NOT NULL,
                "product_id" text,
                "variant_id" text,
                "product_name" text NOT NULL,
                "product_slug" text NOT NULL,
                "variant_label" text,
                "image_url" text,
                "unit_price_usd" numeric(10,2) NOT NULL,
                "quantity" integer NOT NULL,
                "line_total_usd" numeric(10,2) NOT NULL,
                "personalization" text,
                "sort_order" integer NOT NULL DEFAULT 0,
                CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "order_items_quantity_check" CHECK ("quantity" > 0)
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "order_items_order_id_idx" ON "order_items" ("order_id")`,
        )
        await queryRunner.query(`
            ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey"
            FOREIGN KEY ("order_id") REFERENCES "orders" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        `)
        await queryRunner.query(`
            ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey"
            FOREIGN KEY ("product_id") REFERENCES "products" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `)

        await queryRunner.query(`
            CREATE TABLE "order_payments" (
                "id" text NOT NULL,
                "order_id" text NOT NULL,
                "status" text NOT NULL DEFAULT 'PENDIENTE',
                "reference" text NOT NULL,
                "payer_bank_code" text NOT NULL,
                "payer_bank_name" text NOT NULL,
                "payer_phone" text NOT NULL,
                "payer_id_number" text,
                "paid_on" date NOT NULL,
                "amount_bs" numeric(14,2) NOT NULL,
                "expected_bs" numeric(14,2) NOT NULL,
                "duplicate_reference" boolean NOT NULL DEFAULT false,
                "proof_key" text,
                "has_proof" boolean NOT NULL DEFAULT false,
                "rejection_reason" text,
                "reviewed_at" TIMESTAMP(3) WITH TIME ZONE,
                "reviewed_by" text,
                "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "order_payments_status_check"
                    CHECK ("status" IN ('PENDIENTE', 'VERIFICADO', 'RECHAZADO'))
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "order_payments_order_id_idx" ON "order_payments" ("order_id")`,
        )
        await queryRunner.query(
            `CREATE INDEX "order_payments_reference_idx" ON "order_payments" ("reference")`,
        )
        await queryRunner.query(`
            ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_fkey"
            FOREIGN KEY ("order_id") REFERENCES "orders" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        `)
        await queryRunner.query(`
            ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_reviewed_by_fkey"
            FOREIGN KEY ("reviewed_by") REFERENCES "users" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `)

        await queryRunner.query(`
            CREATE TABLE "order_status_history" (
                "id" text NOT NULL,
                "order_id" text NOT NULL,
                "from_status" text,
                "to_status" text NOT NULL,
                "actor_type" text NOT NULL,
                "actor_user_id" text,
                "note" text,
                "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "order_status_history_actor_type_check"
                    CHECK ("actor_type" IN ('admin', 'customer', 'system', 'telegram'))
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "order_status_history_order_id_idx" ON "order_status_history" ("order_id")`,
        )
        await queryRunner.query(`
            ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey"
            FOREIGN KEY ("order_id") REFERENCES "orders" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        `)
        await queryRunner.query(`
            ALTER TABLE "order_status_history"
            ADD CONSTRAINT "order_status_history_actor_user_id_fkey"
            FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `)

        await queryRunner.query(`
            CREATE TABLE "order_notes" (
                "id" text NOT NULL,
                "order_id" text NOT NULL,
                "author_id" text,
                "body" text NOT NULL,
                "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "order_notes_order_id_idx" ON "order_notes" ("order_id")`,
        )
        await queryRunner.query(`
            ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_order_id_fkey"
            FOREIGN KEY ("order_id") REFERENCES "orders" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        `)
        await queryRunner.query(`
            ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_author_id_fkey"
            FOREIGN KEY ("author_id") REFERENCES "users" ("id")
            ON DELETE SET NULL ON UPDATE CASCADE
        `)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "order_notes"`)
        await queryRunner.query(`DROP TABLE "order_status_history"`)
        await queryRunner.query(`DROP TABLE "order_payments"`)
        await queryRunner.query(`DROP TABLE "order_items"`)
        await queryRunner.query(`DROP TABLE "orders"`)
        await queryRunner.query(`DROP SEQUENCE "order_code_seq"`)
        await queryRunner.query(`DROP TABLE "exchange_rates"`)
    }
}
