import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AppSetting } from '../settings/entities/app-setting.entity.js'
import { ExchangeRate } from './entities/exchange-rate.entity.js'
import { AdminExchangeRateController, ExchangeRateController } from './exchange-rate.controller.js'
import { ExchangeRateService } from './exchange-rate.service.js'
import { BcvProvider } from './providers/bcv.provider.js'
import { BinanceProvider } from './providers/binance.provider.js'
import { DolarApiProvider } from './providers/dolarapi.provider.js'
import { EXCHANGE_RATE_PROVIDERS, type ExchangeRateProvider } from './providers/rate-provider.js'

@Module({
    imports: [TypeOrmModule.forFeature([ExchangeRate, AppSetting])],
    controllers: [ExchangeRateController, AdminExchangeRateController],
    providers: [
        ExchangeRateService,
        {
            // Per currency, tried in this order: the official BCV website first, its JSON mirror
            // as fallback (dollar, euro); Binance P2P alone for USDT.
            provide: EXCHANGE_RATE_PROVIDERS,
            useFactory: (): ExchangeRateProvider[] => [
                new BcvProvider(),
                new DolarApiProvider(),
                new BinanceProvider(),
            ],
        },
    ],
    exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
