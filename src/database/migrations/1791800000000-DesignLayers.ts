import { randomUUID } from 'node:crypto'
import type { MigrationInterface, QueryRunner } from 'typeorm'
import {
    layeredToLegacy,
    legacyToLayered,
    type DesignLayer,
    type LayeredAssetRow,
    type LegacyDesignRow,
} from './support/design-legacy.js'

/**
 * "Diseña con tu imagen", Stage 2: layers (up to 5 images and 3 texts) and a print-ready file.
 *
 * - `design_assets`: the private files of a design for printing. `kind` 'original' (the file of
 *   one image layer, `layer_index` = its position in `designs.layers`) or 'artwork' (the "arte
 *   final" PNG, no layer). Storage key, format, pixel size, bytes and print DPI (the arte
 *   final's own, 100–200; the original's effective DPI). `design_id` → `designs`
 *   (CASCADE).
 * - `designs.layers` (jsonb array, see DesignLayer) and `designs.print_size` (jsonb
 *   `{ widthCm, heightCm }`) replace `placement`; `dpi_estimate` becomes the lowest DPI of the
 *   image layers (null for a design with only text).
 * - Data: each existing design becomes one image layer with its 'original' asset (the
 *   `original_*` columns move there, see `legacyToLayered`); then `original_*` and `placement`
 *   are dropped. Stored files are untouched.
 *
 * `down()` rebuilds the single image from the bottom image layer (or the arte final for a design
 * with only text, see `layeredToLegacy`); other layers and assets are lost. A design with no file
 * at all cannot be rebuilt: the migration refuses to go down while one is attached to an order,
 * and deletes the unattached ones.
 */
export class DesignLayers1791800000000 implements MigrationInterface {
    name = 'DesignLayers1791800000000'

    async up(queryRunner: QueryRunner): Promise<void> {
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
            ALTER TABLE "designs"
                ADD COLUMN "layers" jsonb,
                ADD COLUMN "print_size" jsonb,
                ALTER COLUMN "dpi_estimate" DROP NOT NULL
        `)

        const rows = (await queryRunner.query(`
            SELECT "id", "original_key", "original_format", "original_width", "original_height",
                   "original_bytes", "placement", "dpi_estimate"
            FROM "designs"
        `)) as LegacyDesignRow[]
        for (const row of rows) {
            const mapped = legacyToLayered(row)
            await queryRunner.query(
                `UPDATE "designs" SET "layers" = $1::jsonb, "print_size" = $2::jsonb, "dpi_estimate" = $3 WHERE "id" = $4`,
                [
                    JSON.stringify(mapped.layers),
                    JSON.stringify(mapped.printSize),
                    mapped.dpiEstimate,
                    row.id,
                ],
            )
            const { asset } = mapped
            await queryRunner.query(
                `INSERT INTO "design_assets" ("id", "design_id", "kind", "layer_index", "storage_key", "format", "width", "height", "bytes", "dpi")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    randomUUID(),
                    asset.design_id,
                    asset.kind,
                    asset.layer_index,
                    asset.storage_key,
                    asset.format,
                    asset.width,
                    asset.height,
                    asset.bytes,
                    mapped.dpiEstimate,
                ],
            )
        }

        await queryRunner.query(`
            ALTER TABLE "designs"
                ALTER COLUMN "layers" SET NOT NULL,
                ALTER COLUMN "print_size" SET NOT NULL,
                ADD CONSTRAINT "designs_layers_check" CHECK (jsonb_typeof("layers") = 'array'),
                DROP CONSTRAINT "designs_original_format_check",
                DROP CONSTRAINT "designs_original_size_check",
                DROP COLUMN "original_key",
                DROP COLUMN "original_format",
                DROP COLUMN "original_width",
                DROP COLUMN "original_height",
                DROP COLUMN "original_bytes",
                DROP COLUMN "placement"
        `)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "designs"
                ADD COLUMN "original_key" text,
                ADD COLUMN "original_format" varchar(8),
                ADD COLUMN "original_width" integer,
                ADD COLUMN "original_height" integer,
                ADD COLUMN "original_bytes" integer,
                ADD COLUMN "placement" jsonb
        `)

        const designs = (await queryRunner.query(
            `SELECT "id", "layers", "print_size", "attached_at" FROM "designs"`,
        )) as {
            id: string
            layers: DesignLayer[]
            print_size: { widthCm: number; heightCm: number }
            attached_at: Date | null
        }[]
        for (const design of designs) {
            const assets = (await queryRunner.query(
                `SELECT "kind", "layer_index", "storage_key", "format", "width", "height", "bytes"
                 FROM "design_assets" WHERE "design_id" = $1`,
                [design.id],
            )) as LayeredAssetRow[]
            const legacy = layeredToLegacy(design.layers, design.print_size, assets)
            if (!legacy) {
                if (design.attached_at) {
                    throw new Error(
                        `Design ${design.id} is ordered but has no file to keep as its single image`,
                    )
                }
                await queryRunner.query(`DELETE FROM "designs" WHERE "id" = $1`, [design.id])
                continue
            }
            await queryRunner.query(
                `UPDATE "designs"
                 SET "original_key" = $1, "original_format" = $2, "original_width" = $3,
                     "original_height" = $4, "original_bytes" = $5, "placement" = $6::jsonb,
                     "dpi_estimate" = $7
                 WHERE "id" = $8`,
                [
                    legacy.original_key,
                    legacy.original_format,
                    legacy.original_width,
                    legacy.original_height,
                    legacy.original_bytes,
                    JSON.stringify(legacy.placement),
                    legacy.dpi_estimate,
                    design.id,
                ],
            )
        }

        await queryRunner.query(`
            ALTER TABLE "designs"
                DROP CONSTRAINT "designs_layers_check",
                DROP COLUMN "layers",
                DROP COLUMN "print_size",
                ALTER COLUMN "original_key" SET NOT NULL,
                ALTER COLUMN "original_format" SET NOT NULL,
                ALTER COLUMN "original_width" SET NOT NULL,
                ALTER COLUMN "original_height" SET NOT NULL,
                ALTER COLUMN "original_bytes" SET NOT NULL,
                ALTER COLUMN "placement" SET NOT NULL,
                ALTER COLUMN "dpi_estimate" SET NOT NULL,
                ADD CONSTRAINT "designs_original_format_check"
                    CHECK ("original_format" IN ('jpg', 'png', 'webp')),
                ADD CONSTRAINT "designs_original_size_check"
                    CHECK ("original_width" > 0 AND "original_height" > 0 AND "original_bytes" > 0)
        `)
        await queryRunner.query(`DROP TABLE "design_assets"`)
    }
}
