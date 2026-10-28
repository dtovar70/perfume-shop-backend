import { IsIn } from 'class-validator'
import { feminine, msg } from '../../common/validation/messages.js'
import { RATE_CURRENCIES, type RateCurrency } from '../rate-currency.js'

const CURRENCY = feminine('La moneda')

/** `PUT /admin/exchange-rate/active-currency`: the rate checkout converts with. */
export class ActiveCurrencyDto {
    @IsIn(RATE_CURRENCIES, {
        message: `${msg.invalid(CURRENCY)} Usa ${RATE_CURRENCIES.join(', ')}.`,
    })
    currency: RateCurrency
}
