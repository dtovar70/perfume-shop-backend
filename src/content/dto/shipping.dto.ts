import { feminine, masculine } from '../../common/validation/messages.js'
import type { ShippingContent } from '../content.types.js'
import { CONTENT_LIMITS as MAX } from './content-limits.js'
import { ContentMoney, ContentText } from './content-validation.js'

export class ShippingContentDto implements ShippingContent {
    @ContentMoney(masculine('El monto para envío gratis'))
    freeThreshold: number

    @ContentMoney(feminine('La tarifa de envío'))
    flatRate: number

    @ContentText(masculine('El texto de envío gratis'), {
        max: MAX.shortCopy,
        placeholders: ['envioGratis'],
    })
    freeShippingCopy: string

    @ContentText(masculine('El tiempo de producción'), { max: MAX.shortCopy })
    productionCopy: string
}
