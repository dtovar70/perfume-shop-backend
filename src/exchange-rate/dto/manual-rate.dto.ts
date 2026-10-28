import { Transform } from 'class-transformer'
import { IsIn, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator'
import { feminine, msg } from '../../common/validation/messages.js'
import { MAX_PLAUSIBLE_RATE } from '../providers/rate-provider.js'
import { RATE_CURRENCIES, type RateCurrency } from '../rate-currency.js'

const FIELD = {
    rate: feminine('La tasa'),
    effectiveDate: feminine('La fecha valor'),
    currency: feminine('La moneda'),
} as const

export class ManualRateDto {
    @IsNumber(
        { maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false },
        { message: `${FIELD.rate.name} debe ser un número con hasta 4 decimales.` },
    )
    @Min(0.0001, { message: `${FIELD.rate.name} debe ser mayor que 0.` })
    @Max(MAX_PLAUSIBLE_RATE, { message: msg.max(FIELD.rate, MAX_PLAUSIBLE_RATE) })
    rate: number

    /** "YYYY-MM-DD"; defaults to today (Caracas). Checked against the calendar in the service. */
    @IsOptional()
    @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
    @IsString({ message: msg.text(FIELD.effectiveDate) })
    @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: msg.format(FIELD.effectiveDate, 'AAAA-MM-DD') })
    effectiveDate?: string

    /** Which currency the rate is for; 'USD' when absent (older clients). */
    @IsOptional()
    @IsIn(RATE_CURRENCIES, {
        message: `${msg.invalid(FIELD.currency)} Usa ${RATE_CURRENCIES.join(', ')}.`,
    })
    currency?: RateCurrency
}
