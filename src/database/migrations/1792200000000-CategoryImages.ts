import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Optional cover image of a category (the home "Encuentra tu esencia" cards): an external URL
 * or an uploaded file, whose storage key (`image_public_id`, internal) is kept to delete it
 * later. Both columns are nullable, so existing rows simply have no cover.
 */
export class CategoryImages1792200000000 implements MigrationInterface {
    name = 'CategoryImages1792200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "categories"
                ADD COLUMN IF NOT EXISTS "image_url" text,
                ADD COLUMN IF NOT EXISTS "image_public_id" text
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "categories"
                DROP COLUMN IF EXISTS "image_public_id",
                DROP COLUMN IF EXISTS "image_url"
        `)
    }
}
