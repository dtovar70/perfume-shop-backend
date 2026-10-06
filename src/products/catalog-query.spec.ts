import { buildCatalogConditions, CATALOG_ORDER_BY, resolvePageWindow } from './catalog-query.js'
import { computeRelevanceScore, computeSearchText } from './product-derived.js'

const ACTIVE = { clause: 'product.isActive = :isActive', params: { isActive: true } }

describe('buildCatalogConditions', () => {
    it('always restricts the public catalog to active products', () => {
        expect(buildCatalogConditions({})).toEqual([ACTIVE])
    })

    it('maps category, price range and tags to parameterized clauses', () => {
        expect(
            buildCatalogConditions({
                category: 'arabes',
                minPrice: 10,
                maxPrice: 20,
                tags: ['oferta', 'nuevo'],
            }),
        ).toEqual([
            ACTIVE,
            { clause: 'product.categorySlug = :category', params: { category: 'arabes' } },
            { clause: 'product.price >= :minPrice', params: { minPrice: 10 } },
            { clause: 'product.price <= :maxPrice', params: { maxPrice: 20 } },
            {
                clause: 'product.tags @> CAST(:tags AS text[])',
                params: { tags: ['oferta', 'nuevo'] },
            },
        ])
    })

    it('supports an open-ended price range (including 0)', () => {
        expect(buildCatalogConditions({ minPrice: 0 })).toContainEqual({
            clause: 'product.price >= :minPrice',
            params: { minPrice: 0 },
        })
        expect(buildCatalogConditions({ maxPrice: 15 })).toHaveLength(2)
    })

    it('splits the search into accent-insensitive AND terms', () => {
        expect(buildCatalogConditions({ search: '  Mamá   JEFA ' }).slice(1)).toEqual([
            { clause: 'product.searchText LIKE :search0', params: { search0: '%mama%' } },
            { clause: 'product.searchText LIKE :search1', params: { search1: '%jefa%' } },
        ])
    })

    it('escapes LIKE wildcards so they match literally', () => {
        expect(buildCatalogConditions({ search: '100%_x' })[1]?.params).toEqual({
            search0: '%100\\%\\_x%',
        })
    })

    it('never interpolates user input into the SQL clause', () => {
        const conditions = buildCatalogConditions({
            category: "arabes' OR 1=1 --",
            search: "'; DROP TABLE products; --",
        })
        for (const { clause } of conditions) {
            expect(clause).not.toMatch(/DROP|OR 1=1/)
        }
    })

    it('maps brands, gender, concentration and family to parameterized clauses', () => {
        expect(
            buildCatalogConditions({
                brand: ['lattafa', 'armaf'],
                gender: 'mujer',
                concentration: 'EDP',
                family: 'Oriental',
            }).slice(1),
        ).toEqual([
            {
                clause: 'product.brandSlug IN (:...brands)',
                params: { brands: ['lattafa', 'armaf'] },
            },
            { clause: 'product.gender = :gender', params: { gender: 'mujer' } },
            {
                clause: 'product.concentration = :concentration',
                params: { concentration: 'EDP' },
            },
            {
                clause: 'LOWER(product.olfactoryFamily) = LOWER(:family)',
                params: { family: 'Oriental' },
            },
        ])
    })

    it('ignores a blank search', () => {
        expect(buildCatalogConditions({ search: '   ' })).toEqual([ACTIVE])
    })
})

describe('CATALOG_ORDER_BY', () => {
    it('mirrors the frontend mock comparators with a stable tie-breaker', () => {
        expect(CATALOG_ORDER_BY.relevance).toEqual([
            ['product.relevanceScore', 'DESC'],
            ['product.createdAt', 'DESC'],
            ['product.id', 'ASC'],
        ])
        expect(CATALOG_ORDER_BY['price-asc'][0]).toEqual(['product.price', 'ASC'])
        expect(CATALOG_ORDER_BY['price-desc'][0]).toEqual(['product.price', 'DESC'])
        expect(CATALOG_ORDER_BY.newest[0]).toEqual(['product.createdAt', 'DESC'])
        expect(CATALOG_ORDER_BY['name-asc'][0]).toEqual(['product.name', 'ASC'])
    })

    it('has no rating sort: the shop has no reviews', () => {
        expect(Object.keys(CATALOG_ORDER_BY)).not.toContain('rating')
    })
})

describe('resolvePageWindow', () => {
    it('computes skip and total pages', () => {
        expect(resolvePageWindow(30, 2, 12)).toEqual({
            page: 2,
            pageSize: 12,
            total: 30,
            totalPages: 3,
            skip: 12,
        })
    })

    it('clamps out-of-range pages like the mock', () => {
        expect(resolvePageWindow(30, 99, 12).page).toBe(3)
        expect(resolvePageWindow(0, 5, 12)).toMatchObject({ page: 1, totalPages: 1, skip: 0 })
    })
})

describe('derived product fields', () => {
    it('scores featured (+20), bestsellers (+10) and new products (+4) only', () => {
        expect(computeRelevanceScore({ tags: ['bestseller', 'nuevo'] })).toBe(14)
        expect(computeRelevanceScore({ tags: ['bestseller'] })).toBe(10)
        expect(computeRelevanceScore({ tags: ['nuevo'] })).toBe(4)
        expect(computeRelevanceScore({ tags: ['oferta'] })).toBe(0)
        expect(computeRelevanceScore({ tags: ['nuevo'], isFeatured: true })).toBe(24)
    })

    it('ignores the legacy rating when scoring', () => {
        const withRating = { tags: ['bestseller'], rating: 4.9 }
        expect(computeRelevanceScore(withRating)).toBe(10)
    })

    it('builds a normalized search haystack including tags', () => {
        expect(
            computeSearchText({
                name: 'Khamrah',
                description: 'Dátiles',
                tags: ['oferta'],
            }),
        ).toBe('khamrah datiles oferta')
    })

    it('includes the brand, gender, concentration, family and notes', () => {
        expect(
            computeSearchText({
                name: 'Yara',
                description: '',
                tags: [],
                brandName: 'Lattafa',
                gender: 'mujer',
                concentration: 'EDP',
                olfactoryFamily: 'Floral frutal',
                notesTop: ['Orquídea'],
                notesHeart: ['Frutas tropicales'],
                notesBase: ['Vainilla'],
            }),
        ).toBe(
            'yara lattafa mujer edp eau de parfum floral frutal orquidea frutas tropicales vainilla',
        )
    })

    it('adds "favorito" for bestsellers, the word the store shows', () => {
        expect(
            computeSearchText({
                name: 'Yara',
                description: '',
                tags: ['bestseller'],
            }),
        ).toContain('bestseller favorito')
    })
})
