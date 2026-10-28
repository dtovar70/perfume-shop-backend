import { Global, Module } from '@nestjs/common'
import { RealtimeModule } from '../realtime/realtime.module.js'
import { CacheInvalidator } from './cache-invalidator.js'
import { CacheInvalidationInterceptor } from './invalidates-cache.decorator.js'
import { MemoryCache } from './memory-cache.js'

/** Global: the cached readers and the writers that invalidate live in every feature module. */
@Global()
@Module({
    imports: [RealtimeModule],
    providers: [MemoryCache, CacheInvalidator, CacheInvalidationInterceptor],
    exports: [MemoryCache, CacheInvalidator, CacheInvalidationInterceptor],
})
export class CacheModule {}
