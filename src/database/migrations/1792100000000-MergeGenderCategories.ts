import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Perfume houses filed under `arabes`; every other brand (or none) goes to `europeos`. */
const ARABIC_BRANDS = ['lattafa', 'armaf', 'afnan', 'rasasi', 'maison-alhambra', 'al-haramain']

/** Gender categories that duplicated the `products.gender` filter. */
const GENDER_CATEGORIES = [
    {
        slug: 'mujer',
        name: 'Mujer',
        tagline: 'Femeninas, magnéticas, inolvidables',
        description:
            'Florales luminosos, gourmands seductores y frutales llenos de vida. Fragancias que acompañan cada faceta de tu día.',
        colorHex: '#E8B4B8',
    },
    {
        slug: 'hombre',
        name: 'Hombre',
        tagline: 'Presencia que se recuerda',
        description:
            'Aromáticos frescos, amaderados profundos y especiados con carácter. Para el que deja huella sin decir una palabra.',
        colorHex: '#8C6A4F',
    },
    {
        slug: 'unisex',
        name: 'Unisex',
        tagline: 'Sin reglas, solo esencia',
        description:
            'Fragancias que no entienden de etiquetas: ámbar, maderas y resinas pensadas para quien elige por instinto.',
        colorHex: '#D4AF7A',
    },
] as const

/** The type categories products move into, as seeded (`categories.data.ts`). */
const TYPE_CATEGORIES = [
    {
        slug: 'arabes',
        name: 'Árabes',
        tagline: 'La opulencia de Oriente',
        description:
            'Oud, ámbar, azafrán y especias en fragancias intensas y duraderas de las grandes casas de Dubái y Emiratos. Lujo envolvente a un precio sorprendente.',
        colorHex: '#C9A227',
        sortOrder: 0,
    },
    {
        slug: 'europeos',
        name: 'Europeos',
        tagline: 'Los clásicos de diseñador',
        description:
            'Las firmas que marcaron época: Dior, Carolina Herrera, Versace y Jean Paul Gaultier. Elegancia reconocible al primer instante.',
        colorHex: '#B76E79',
        sortOrder: 1,
    },
] as const

const GENDER_SLUGS = GENDER_CATEGORIES.map((category) => category.slug)

/**
 * Categories become the perfume type only (`arabes`, `europeos`, `sets-regalo`); Mujer / Hombre /
 * Unisex stay as the `products.gender` filter. Data only.
 *
 * `up()`: makes sure `arabes` and `europeos` exist (inserted only when missing), moves every
 * product of the `mujer`, `hombre` and `unisex` categories to `arabes` or `europeos` by its
 * `brand_slug` (no brand → `europeos`), then deletes those three categories.
 *
 * References to `categories.slug`: only `products.category_slug`
 * (`products_category_slug_fkey`, ON DELETE RESTRICT ON UPDATE CASCADE), so the delete runs
 * after the products move and can neither fail nor orphan rows. Orders do not reference
 * categories: `order_items` keeps a `product_slug` snapshot only.
 *
 * Safe on a fresh database: the target categories are inserted only when some product needs
 * them, so with no products every statement is a no-op and the seed creates the categories.
 *
 * `down()`: recreates the three categories (only when missing) after the current ones. Products
 * are NOT moved back: their old category is not recorded, and `gender` keeps the same split.
 */
export class MergeGenderCategories1792100000000 implements MigrationInterface {
    name = 'MergeGenderCategories1792100000000'

    async up(queryRunner: QueryRunner): Promise<void> {
        const [row] = (await queryRunner.query(
            `SELECT count(*)::int AS "count" FROM "products" WHERE "category_slug" = ANY ($1)`,
            [GENDER_SLUGS],
        )) as { count: number }[]
        if ((row?.count ?? 0) > 0) {
            for (const category of TYPE_CATEGORIES) {
                await queryRunner.query(
                    `INSERT INTO "categories" ("slug", "name", "tagline", "description", "color_hex", "sort_order")
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT ("slug") DO NOTHING`,
                    [
                        category.slug,
                        category.name,
                        category.tagline,
                        category.description,
                        category.colorHex,
                        category.sortOrder,
                    ],
                )
            }
        }

        await queryRunner.query(
            `UPDATE "products"
             SET "category_slug" = CASE
                     WHEN "brand_slug" = ANY ($2) THEN 'arabes'
                     ELSE 'europeos'
                 END,
                 "updated_at" = now()
             WHERE "category_slug" = ANY ($1)`,
            [GENDER_SLUGS, ARABIC_BRANDS],
        )
        await queryRunner.query(`DELETE FROM "categories" WHERE "slug" = ANY ($1)`, [GENDER_SLUGS])
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        for (const category of GENDER_CATEGORIES) {
            await queryRunner.query(
                `INSERT INTO "categories" ("slug", "name", "tagline", "description", "color_hex", "sort_order")
                 SELECT $1, $2, $3, $4, $5, COALESCE(MAX("sort_order") + 1, 0) FROM "categories"
                 ON CONFLICT ("slug") DO NOTHING`,
                [
                    category.slug,
                    category.name,
                    category.tagline,
                    category.description,
                    category.colorHex,
                ],
            )
        }
    }
}
