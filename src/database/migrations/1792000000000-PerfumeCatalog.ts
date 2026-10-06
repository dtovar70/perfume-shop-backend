import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Status copy of the old brand (the workshop, the 🐾 mascot), as seeded before and after this change. */
const STATUS_COPY = [
    {
        code: 'PENDIENTE_PAGO',
        column: 'whatsapp_template',
        before: '¡Hola {nombre}! 🐾 Gracias por tu pedido {pedido} en {marca}. Te recordamos que el total es {total}. Puedes pagar por Pago Móvil y subir tu comprobante aquí: {enlace}',
        after: '¡Hola {nombre}! ✨ Gracias por tu pedido {pedido} en {marca}. Te recordamos que el total es {total}. Puedes pagar por Pago Móvil y subir tu comprobante aquí: {enlace}',
    },
    {
        code: 'PAGO_VERIFICADO',
        column: 'customer_description',
        before: 'Gracias. Muy pronto empezamos a preparar tu pedido en el taller.',
        after: 'Gracias. Muy pronto empezamos a preparar tu pedido.',
    },
    {
        code: 'EN_PRODUCCION',
        column: 'customer_description',
        before: 'Lo estamos personalizando en el taller. {produccion}.',
        after: 'Lo estamos revisando y empacando con cuidado. {produccion}.',
    },
    {
        code: 'PAGO_VERIFICADO',
        column: 'whatsapp_template',
        before: '¡Hola {nombre}! ✅ Confirmamos tu pago del pedido {pedido}. Ya estamos preparando tu pieza. Tu comprobante: {comprobante} · Sigue tu pedido: {enlace}',
        after: '¡Hola {nombre}! ✅ Confirmamos tu pago del pedido {pedido}. Ya estamos preparando tu perfume. Tu comprobante: {comprobante} · Sigue tu pedido: {enlace}',
    },
    {
        code: 'EN_PRODUCCION',
        column: 'whatsapp_template',
        before: '¡Hola {nombre}! 🎨 Tu pedido {pedido} ya está en el taller y lo estamos personalizando con mucho cariño. Síguelo aquí: {enlace}',
        after: '¡Hola {nombre}! ✨ Tu pedido {pedido} ya se está preparando: revisamos y empacamos tu perfume con mucho cuidado. Síguelo aquí: {enlace}',
    },
] as const

/**
 * KaiZen: the sublimation store becomes a perfume store.
 *
 * - `brands`: perfume houses (`slug` PK, name, optional logo — an external URL or an uploaded
 *   file with its storage key —, description, position, active flag, timestamps).
 * - `products`: `brand_slug` → `brands` (SET NULL), `gender` ('mujer' | 'hombre' | 'unisex',
 *   default 'unisex'), `concentration` ('EDC' | 'EDT' | 'EDP' | 'PARFUM' | 'EXTRAIT'), `volume_ml`,
 *   the olfactory pyramid (`notes_top`, `notes_heart`, `notes_base`, text[]), `olfactory_family`,
 *   `is_featured` and a unique optional `sku`. `print_text` and `color_hex` are dropped.
 * - `product_variants`: `volume_ml` replaces `color_hex`.
 * - Sublimation features removed: `order_items.personalization` / `design_id`, the `designs`,
 *   `design_assets` and `category_design_templates` tables, and the categories' print size.
 *   Stored design files are not deleted.
 * - Data: the status copy about the workshop is reworded, only where it was never edited.
 *
 * `down()` recreates every dropped table and column (empty or nullable: the old values are
 * gone; `print_text` comes back as '' and `color_hex` as '#FFFFFF') and drops the perfume ones.
 */
export class PerfumeCatalog1792000000000 implements MigrationInterface {
    name = 'PerfumeCatalog1792000000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "brands" (
                "slug" varchar(100) NOT NULL,
                "name" varchar(100) NOT NULL,
                "logo_url" text,
                "logo_public_id" text,
                "description" text NOT NULL DEFAULT '',
                "sort_order" integer NOT NULL DEFAULT 0,
                "is_active" boolean NOT NULL DEFAULT true,
                "created_at" timestamptz(3) NOT NULL DEFAULT now(),
                "updated_at" timestamptz(3) NOT NULL DEFAULT now(),
                CONSTRAINT "brands_pkey" PRIMARY KEY ("slug"),
                CONSTRAINT "brands_description_length_check"
                    CHECK (char_length("description") <= 1000)
            )
        `)

        await queryRunner.query(`
            ALTER TABLE "products"
                ADD COLUMN "brand_slug" varchar(100),
                ADD COLUMN "gender" varchar(16) NOT NULL DEFAULT 'unisex',
                ADD COLUMN "concentration" varchar(16),
                ADD COLUMN "volume_ml" integer,
                ADD COLUMN "notes_top" text[] NOT NULL DEFAULT '{}',
                ADD COLUMN "notes_heart" text[] NOT NULL DEFAULT '{}',
                ADD COLUMN "notes_base" text[] NOT NULL DEFAULT '{}',
                ADD COLUMN "olfactory_family" varchar(100),
                ADD COLUMN "is_featured" boolean NOT NULL DEFAULT false,
                ADD COLUMN "sku" varchar(100),
                ADD CONSTRAINT "products_gender_check"
                    CHECK ("gender" IN ('mujer', 'hombre', 'unisex')),
                ADD CONSTRAINT "products_concentration_check" CHECK (
                    "concentration" IS NULL
                    OR "concentration" IN ('EDC', 'EDT', 'EDP', 'PARFUM', 'EXTRAIT')
                ),
                ADD CONSTRAINT "products_volume_ml_check"
                    CHECK ("volume_ml" IS NULL OR "volume_ml" > 0),
                ADD CONSTRAINT "products_notes_count_check" CHECK (
                    cardinality("notes_top") <= 12 AND cardinality("notes_heart") <= 12
                    AND cardinality("notes_base") <= 12
                ),
                ADD CONSTRAINT "products_brand_slug_fkey"
                    FOREIGN KEY ("brand_slug") REFERENCES "brands" ("slug")
                    ON DELETE SET NULL ON UPDATE CASCADE,
                DROP COLUMN "print_text",
                DROP COLUMN "color_hex"
        `)
        await queryRunner.query(
            `CREATE INDEX "products_brand_slug_idx" ON "products" ("brand_slug")`,
        )
        await queryRunner.query(`CREATE UNIQUE INDEX "products_sku_key" ON "products" ("sku")`)

        await queryRunner.query(`
            ALTER TABLE "product_variants"
                ADD COLUMN "volume_ml" integer,
                ADD CONSTRAINT "product_variants_volume_ml_check"
                    CHECK ("volume_ml" IS NULL OR "volume_ml" > 0),
                DROP COLUMN "color_hex"
        `)

        // Sublimation features. The foreign key to `designs` goes with its column.
        await queryRunner.query(`
            ALTER TABLE "order_items"
                DROP CONSTRAINT "order_items_personalization_length_check",
                DROP COLUMN "personalization",
                DROP COLUMN "design_id"
        `)
        await queryRunner.query(`DROP TABLE "design_assets"`)
        await queryRunner.query(`DROP TABLE "designs"`)
        await queryRunner.query(`DROP TABLE "category_design_templates"`)
        await queryRunner.query(`
            ALTER TABLE "categories"
                DROP CONSTRAINT "categories_design_print_size_check",
                DROP COLUMN "design_print_width_cm",
                DROP COLUMN "design_print_height_cm"
        `)

        for (const copy of STATUS_COPY) {
            await queryRunner.query(
                `UPDATE "order_statuses" SET "${copy.column}" = $1 WHERE "code" = $2 AND "${copy.column}" = $3`,
                [copy.after, copy.code, copy.before],
            )
        }
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        for (const copy of STATUS_COPY) {
            await queryRunner.query(
                `UPDATE "order_statuses" SET "${copy.column}" = $1 WHERE "code" = $2 AND "${copy.column}" = $3`,
                [copy.before, copy.code, copy.after],
            )
        }

        await queryRunner.query(`
            ALTER TABLE "categories"
                ADD COLUMN "design_print_width_cm" numeric(6,2),
                ADD COLUMN "design_print_height_cm" numeric(6,2),
                ADD CONSTRAINT "categories_design_print_size_check" CHECK (
                    ("design_print_width_cm" IS NULL AND "design_print_height_cm" IS NULL)
                    OR ("design_print_width_cm" > 0 AND "design_print_width_cm" <= 100
                        AND "design_print_height_cm" > 0 AND "design_print_height_cm" <= 100)
                )
        `)
        await queryRunner.query(`
            CREATE TABLE "category_design_templates" (
                "id" text NOT NULL,
                "category_slug" varchar(100) NOT NULL,
                "color_name" varchar(40) NOT NULL,
                "color_hex" varchar(7) NOT NULL,
                "image_url" text NOT NULL,
                "public_id" text NOT NULL,
                "width" integer NOT NULL,
                "height" integer NOT NULL,
                "print_area" jsonb NOT NULL,
                "sort_order" integer NOT NULL DEFAULT 0,
                "created_at" timestamptz(3) NOT NULL DEFAULT now(),
                CONSTRAINT "category_design_templates_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "category_design_templates_color_hex_check"
                    CHECK ("color_hex" ~ '^#[0-9A-F]{6}$'),
                CONSTRAINT "category_design_templates_color_name_check"
                    CHECK (char_length(btrim("color_name")) > 0),
                CONSTRAINT "category_design_templates_size_check"
                    CHECK ("width" > 0 AND "height" > 0),
                CONSTRAINT "category_design_templates_print_area_check"
                    CHECK (jsonb_typeof("print_area") = 'object'),
                CONSTRAINT "category_design_templates_category_slug_fkey"
                    FOREIGN KEY ("category_slug") REFERENCES "categories" ("slug")
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "category_design_templates_category_slug_idx" ON "category_design_templates" ("category_slug", "sort_order")`,
        )
        await queryRunner.query(
            `CREATE UNIQUE INDEX "category_design_templates_color_name_key" ON "category_design_templates" ("category_slug", lower("color_name"))`,
        )

        await queryRunner.query(`
            CREATE TABLE "designs" (
                "id" text NOT NULL,
                "product_id" text,
                "variant_id" text,
                "preview_key" text NOT NULL,
                "dpi_estimate" integer,
                "preview_token_hash" text NOT NULL,
                "attached_at" timestamptz(3),
                "created_at" timestamptz(3) NOT NULL DEFAULT now(),
                "color_name" varchar(40),
                "color_hex" varchar(7),
                "layers" jsonb NOT NULL,
                "print_size" jsonb NOT NULL,
                CONSTRAINT "designs_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "designs_color_check" CHECK (
                    ("color_name" IS NULL AND "color_hex" IS NULL)
                    OR ("color_name" IS NOT NULL AND "color_hex" IS NOT NULL)
                ),
                CONSTRAINT "designs_layers_check" CHECK (jsonb_typeof("layers") = 'array'),
                CONSTRAINT "designs_preview_token_hash_check"
                    CHECK ("preview_token_hash" ~ '^[a-f0-9]{64}$'),
                CONSTRAINT "designs_product_id_fkey"
                    FOREIGN KEY ("product_id") REFERENCES "products" ("id")
                    ON DELETE SET NULL ON UPDATE CASCADE
            )
        `)
        await queryRunner.query(`CREATE INDEX "designs_product_id_idx" ON "designs" ("product_id")`)
        await queryRunner.query(
            `CREATE INDEX "designs_attached_at_created_at_idx" ON "designs" ("attached_at", "created_at")`,
        )
        await queryRunner.query(`
            CREATE TABLE "design_assets" (
                "id" text NOT NULL,
                "design_id" text NOT NULL,
                "kind" varchar(16) NOT NULL,
                "layer_index" integer,
                "storage_key" text NOT NULL,
                "format" varchar(8) NOT NULL,
                "width" integer NOT NULL,
                "height" integer NOT NULL,
                "bytes" integer NOT NULL,
                "dpi" integer,
                "created_at" timestamptz(3) NOT NULL DEFAULT now(),
                CONSTRAINT "design_assets_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "design_assets_kind_check" CHECK ("kind" IN ('original', 'artwork')),
                CONSTRAINT "design_assets_format_check"
                    CHECK ("format" IN ('jpg', 'png', 'webp')),
                CONSTRAINT "design_assets_layer_check" CHECK (
                    ("kind" = 'original' AND "layer_index" >= 0)
                    OR ("kind" = 'artwork' AND "layer_index" IS NULL AND "format" = 'png')
                ),
                CONSTRAINT "design_assets_size_check"
                    CHECK ("width" > 0 AND "height" > 0 AND "bytes" > 0),
                CONSTRAINT "design_assets_dpi_check" CHECK ("dpi" IS NULL OR "dpi" > 0),
                CONSTRAINT "design_assets_design_id_fkey"
                    FOREIGN KEY ("design_id") REFERENCES "designs" ("id")
                    ON DELETE CASCADE ON UPDATE CASCADE
            )
        `)
        await queryRunner.query(
            `CREATE INDEX "design_assets_design_id_idx" ON "design_assets" ("design_id")`,
        )

        await queryRunner.query(`
            ALTER TABLE "order_items"
                ADD COLUMN "personalization" text,
                ADD COLUMN "design_id" text,
                ADD CONSTRAINT "order_items_personalization_length_check"
                    CHECK (char_length("personalization") <= 140),
                ADD CONSTRAINT "order_items_design_id_fkey"
                    FOREIGN KEY ("design_id") REFERENCES "designs" ("id")
                    ON DELETE RESTRICT ON UPDATE CASCADE
        `)
        await queryRunner.query(
            `CREATE UNIQUE INDEX "order_items_design_id_key" ON "order_items" ("design_id")`,
        )

        await queryRunner.query(`
            ALTER TABLE "product_variants"
                DROP CONSTRAINT "product_variants_volume_ml_check",
                DROP COLUMN "volume_ml",
                ADD COLUMN "color_hex" varchar(100)
        `)

        await queryRunner.query(`DROP INDEX "products_sku_key"`)
        await queryRunner.query(`DROP INDEX "products_brand_slug_idx"`)
        await queryRunner.query(`
            ALTER TABLE "products"
                DROP CONSTRAINT "products_brand_slug_fkey",
                DROP CONSTRAINT "products_notes_count_check",
                DROP CONSTRAINT "products_volume_ml_check",
                DROP CONSTRAINT "products_concentration_check",
                DROP CONSTRAINT "products_gender_check",
                DROP COLUMN "sku",
                DROP COLUMN "is_featured",
                DROP COLUMN "olfactory_family",
                DROP COLUMN "notes_base",
                DROP COLUMN "notes_heart",
                DROP COLUMN "notes_top",
                DROP COLUMN "volume_ml",
                DROP COLUMN "concentration",
                DROP COLUMN "gender",
                DROP COLUMN "brand_slug",
                ADD COLUMN "print_text" varchar(100) NOT NULL DEFAULT '',
                ADD COLUMN "color_hex" varchar(100) NOT NULL DEFAULT '#FFFFFF'
        `)
        await queryRunner.query(`
            ALTER TABLE "products"
                ALTER COLUMN "print_text" DROP DEFAULT,
                ALTER COLUMN "color_hex" DROP DEFAULT
        `)

        await queryRunner.query(`DROP TABLE "brands"`)
    }
}
