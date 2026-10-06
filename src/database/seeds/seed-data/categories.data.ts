import type { SeedCategory } from './types.js'

/** Array order = sortOrder. */
export const categories: SeedCategory[] = [
    {
        slug: 'arabes',
        name: 'Árabes',
        tagline: 'La opulencia de Oriente',
        description:
            'Oud, ámbar, azafrán y especias en fragancias intensas y duraderas de las grandes casas de Dubái y Emiratos. Lujo envolvente a un precio sorprendente.',
        colorHex: '#C9A227',
    },
    {
        slug: 'europeos',
        name: 'Europeos',
        tagline: 'Los clásicos de diseñador',
        description:
            'Las firmas que marcaron época: Dior, Carolina Herrera, Versace y Jean Paul Gaultier. Elegancia reconocible al primer instante.',
        colorHex: '#B76E79',
    },
    {
        slug: 'sets-regalo',
        name: 'Sets y regalos',
        tagline: 'El detalle perfecto, listo para regalar',
        description:
            'Estuches con perfume y complementos en presentación de regalo. Para sorprender en cumpleaños, aniversarios y fechas especiales.',
        colorHex: '#F2C6C2',
    },
]
