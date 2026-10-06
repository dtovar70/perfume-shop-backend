import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * "Plantilla para diseñar": a photo of the blank product per category, uploaded by the admin,
 * that the customer's design editor uses instead of the generated illustration.
 *
 * - `design_template_image_url` / `design_template_public_id`: the public stored image
 *   (a `design-templates/` Cloudinary folder of the previous store), with its pixel size in
 *   `design_template_width` / `design_template_height`. All four are set together or none.
 * - `design_print_area` (jsonb `{ x, y, width, height }`, 0..1 relative to the photo): where the
 *   print goes on the photo. Only kept while there is a photo (validated by the API).
 * - `design_print_width_cm` / `design_print_height_cm`: the physical print size (0 < cm ≤ 100),
 *   set together or none. They also override the hardcoded sizes of the illustration templates.
 *
 * Data: the three categories with a hardcoded illustration template (mugs, tees, keychains) get
 * their current print size, so nothing changes for them. `down()` drops the columns (a stored
 * photo is not deleted).
 */
export class CategoryDesignTemplates1791600000000 implements MigrationInterface {
    name = 'CategoryDesignTemplates1791600000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "categories"
                ADD COLUMN "design_template_image_url" text,
                ADD COLUMN "design_template_public_id" text,
                ADD COLUMN "design_template_width" integer,
                ADD COLUMN "design_template_height" integer,
                ADD COLUMN "design_print_area" jsonb,
                ADD COLUMN "design_print_width_cm" numeric(6,2),
                ADD COLUMN "design_print_height_cm" numeric(6,2)
        `)
        await queryRunner.query(`
            ALTER TABLE "categories"
                ADD CONSTRAINT "categories_design_template_check" CHECK (
                    ("design_template_image_url" IS NULL AND "design_template_public_id" IS NULL
                        AND "design_template_width" IS NULL AND "design_template_height" IS NULL)
                    OR ("design_template_image_url" IS NOT NULL
                        AND "design_template_public_id" IS NOT NULL
                        AND "design_template_width" > 0 AND "design_template_height" > 0)
                ),
                ADD CONSTRAINT "categories_design_print_area_check" CHECK (
                    "design_print_area" IS NULL
                    OR ("design_template_image_url" IS NOT NULL
                        AND jsonb_typeof("design_print_area") = 'object')
                ),
                ADD CONSTRAINT "categories_design_print_size_check" CHECK (
                    ("design_print_width_cm" IS NULL AND "design_print_height_cm" IS NULL)
                    OR ("design_print_width_cm" > 0 AND "design_print_width_cm" <= 100
                        AND "design_print_height_cm" > 0 AND "design_print_height_cm" <= 100)
                )
        `)
        await queryRunner.query(`
            UPDATE "categories" AS c
            SET "design_print_width_cm" = s.width_cm, "design_print_height_cm" = s.height_cm
            FROM (VALUES ('mugs', 20, 8.5), ('tees', 25, 30), ('keychains', 5, 5))
                AS s (slug, width_cm, height_cm)
            WHERE c."slug" = s.slug
        `)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "categories"
                DROP CONSTRAINT "categories_design_print_size_check",
                DROP CONSTRAINT "categories_design_print_area_check",
                DROP CONSTRAINT "categories_design_template_check",
                DROP COLUMN "design_print_height_cm",
                DROP COLUMN "design_print_width_cm",
                DROP COLUMN "design_print_area",
                DROP COLUMN "design_template_height",
                DROP COLUMN "design_template_width",
                DROP COLUMN "design_template_public_id",
                DROP COLUMN "design_template_image_url"
        `)
    }
}
