import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The `announcements` content section (the storefront ticker) was removed. `up()` deletes its
 * stored row, if any; the API already ignores it. `down()` stores the section's former default
 * messages again (an edited value cannot be recovered).
 */
export class DropAnnouncementsContent1792500000000 implements MigrationInterface {
    name = 'DropAnnouncementsContent1792500000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "site_content" WHERE "key" = 'announcements'`)
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const value = {
            messages: [
                'Envío gratis desde {envioGratis}',
                'Perfumes 100% originales',
                'Paga con Pago Móvil a tasa BCV',
            ],
        }
        await queryRunner.query(
            `INSERT INTO "site_content" ("key", "value", "updated_at", "updated_by")
             VALUES ('announcements', $1::jsonb, now(), NULL)
             ON CONFLICT ("key") DO NOTHING`,
            [JSON.stringify(value)],
        )
    }
}
