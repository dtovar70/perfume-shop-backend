import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CatalogQueryDto } from './catalog-query.dto.js'

async function parse(query: Record<string, unknown>) {
    const dto = plainToInstance(CatalogQueryDto, query)
    const errors = await validate(dto)
    return { dto, errors: errors.flatMap((error) => Object.values(error.constraints ?? {})) }
}

describe('CatalogQueryDto sort', () => {
    it('defaults to relevance', async () => {
        const { dto, errors } = await parse({})
        expect(errors).toEqual([])
        expect(dto.sort).toBe('relevance')
    })

    it('keeps a supported sort', async () => {
        const { dto, errors } = await parse({ sort: 'price-asc' })
        expect(errors).toEqual([])
        expect(dto.sort).toBe('price-asc')
    })

    it('falls back to relevance for the retired rating sort (old bookmarked URLs)', async () => {
        const { dto, errors } = await parse({ sort: 'rating' })
        expect(errors).toEqual([])
        expect(dto.sort).toBe('relevance')
    })

    it('rejects an unknown sort', async () => {
        const { errors } = await parse({ sort: 'cheapest' })
        expect(errors).toEqual(['El orden solicitado no es válido.'])
    })
})

describe('CatalogQueryDto perfume filters', () => {
    it('accepts repeated or comma-separated brands, a gender, a concentration and a family', async () => {
        const { dto, errors } = await parse({
            brand: ['lattafa', 'armaf,afnan'],
            gender: 'mujer',
            concentration: 'EDP',
            family: '  Oriental ',
            sort: 'name-asc',
        })
        expect(errors).toEqual([])
        expect(dto.brand).toEqual(['lattafa', 'armaf', 'afnan'])
        expect(dto.family).toBe('Oriental')
        expect(dto.sort).toBe('name-asc')
    })

    it('rejects an unknown gender or concentration', async () => {
        const { errors } = await parse({ gender: 'otro', concentration: 'XYZ' })
        expect(errors).toHaveLength(2)
    })
})
