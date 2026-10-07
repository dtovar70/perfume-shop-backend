import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Role } from '../auth/role.enum.js'
import { CurrentUser } from '../common/decorators/current-user.decorator.js'
import { Public } from '../common/decorators/public.decorator.js'
import { PublicCache } from '../common/http/public-cache.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import type { AuthUser } from '../common/types/auth-user.js'
import { ManualRateDto } from './dto/manual-rate.dto.js'
import {
    ExchangeRateService,
    type AdminExchangeRateDto,
    type PublicCurrentRateDto,
    type SyncResult,
} from './exchange-rate.service.js'

/** The storefront shows approximate bolívar amounts in the cart and checkout with this. */
@Public()
@Controller('exchange-rate')
export class ExchangeRateController {
    constructor(private readonly rates: ExchangeRateService) {}

    @Get('current')
    @PublicCache(60)
    current(): Promise<PublicCurrentRateDto> {
        return this.rates.publicCurrent()
    }
}

@Roles(Role.ADMIN, Role.EDITOR)
@Controller('admin/exchange-rate')
export class AdminExchangeRateController {
    constructor(private readonly rates: ExchangeRateService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    get(): Promise<AdminExchangeRateDto> {
        return this.rates.adminView()
    }

    /** Asks the providers right away ("Actualizar ahora"). */
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 6, ttl: 60_000 } })
    async refresh(): Promise<AdminExchangeRateDto & { sync: SyncResult }> {
        const sync = await this.rates.sync()
        return { ...(await this.rates.adminView()), sync }
    }

    /** Used until the providers report a different rate. */
    @Roles(Role.ADMIN)
    @Post('manual')
    @HttpCode(HttpStatus.OK)
    setManual(
        @Body() dto: ManualRateDto,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminExchangeRateDto> {
        return this.rates.setManual(dto.rate, dto.effectiveDate, user)
    }
}
