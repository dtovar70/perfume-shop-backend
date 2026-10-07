import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { AppModule } from './app.module.js'
import { createValidationPipe } from './common/pipes/validation.pipe.js'
import { corsOptions } from './config/cors.js'
import type { Env } from './config/env.schema.js'
import { API_PREFIX, GLOBAL_PREFIX_OPTIONS } from './config/global-prefix.js'
import { applyTrustProxy, resolveTrustProxy } from './config/trust-proxy.js'
import { LOCAL_UPLOADS_DIR } from './storage/local-storage.service.js'

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule)
    const config = app.get<ConfigService<Env, true>>(ConfigService)

    // Before any middleware reads req.ip (the throttler keys on it); see applyTrustProxy.
    applyTrustProxy(
        app,
        resolveTrustProxy({
            NODE_ENV: config.get('NODE_ENV', { infer: true }),
            TRUST_PROXY: config.get('TRUST_PROXY', { infer: true }),
        }),
    )
    // `/sitemap.xml` stays at the root (see GLOBAL_PREFIX_OPTIONS).
    app.setGlobalPrefix(API_PREFIX, GLOBAL_PREFIX_OPTIONS)
    // Images are loaded cross-origin by the storefront, so relax CORP for static files.
    app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
    app.use(cookieParser())
    app.enableCors(corsOptions(config.get('CORS_ORIGIN', { infer: true })))
    app.useGlobalPipes(createValidationPipe())
    // Local-disk image storage (dev fallback). Not affected by the /api prefix.
    app.useStaticAssets(LOCAL_UPLOADS_DIR, { prefix: '/uploads/', index: false })
    app.enableShutdownHooks()

    const port = config.get('PORT', { infer: true })
    await app.listen(port)
    const publicUrl = config.get('PUBLIC_API_URL', { infer: true })
    Logger.log(`API listening on port ${port}, public URL ${publicUrl}/api`, 'Bootstrap')
}

await bootstrap()
