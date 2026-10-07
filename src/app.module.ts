import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { ScheduleModule } from '@nestjs/schedule'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { AuthModule } from './auth/auth.module.js'
import { PasswordResetModule } from './auth/password-reset/password-reset.module.js'
import { BrandsModule } from './brands/brands.module.js'
import { CacheModule } from './cache/cache.module.js'
import { CatalogsModule } from './catalogs/catalogs.module.js'
import { CategoriesModule } from './categories/categories.module.js'
import { RequestLoggingMiddleware } from './common/http/request-logging.middleware.js'
import { TOO_MANY_REQUESTS_MESSAGE } from './common/http/throttle.js'
import { ContactModule } from './contact/contact.module.js'
import { ContentModule } from './content/content.module.js'
import { validateEnv } from './config/env.schema.js'
import { DatabaseModule } from './database/database.module.js'
import { ExchangeRateModule } from './exchange-rate/exchange-rate.module.js'
import { HealthController } from './health/health.controller.js'
import { OrdersModule } from './orders/orders.module.js'
import { OutboxModule } from './outbox/outbox.module.js'
import { ProductsModule } from './products/products.module.js'
import { SitemapModule } from './sitemap/sitemap.module.js'
import { StorageModule } from './storage/storage.module.js'
import { TelegramModule } from './telegram/telegram.module.js'
import { UsersModule } from './users/users.module.js'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
        ThrottlerModule.forRoot({
            throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
            errorMessage: TOO_MANY_REQUESTS_MESSAGE,
        }),
        // Domain events (order.created, order.payment_submitted, order.status_changed,
        // contact.message_received); the Telegram bot listens to them.
        EventEmitterModule.forRoot(),
        ScheduleModule.forRoot(),
        DatabaseModule,
        CacheModule,
        OutboxModule,
        StorageModule,
        AuthModule,
        ProductsModule,
        CategoriesModule,
        BrandsModule,
        CatalogsModule,
        ContentModule,
        ExchangeRateModule,
        OrdersModule,
        TelegramModule,
        UsersModule,
        PasswordResetModule,
        ContactModule,
        SitemapModule,
    ],
    controllers: [HealthController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RequestLoggingMiddleware).forRoutes('{*splat}')
    }
}
