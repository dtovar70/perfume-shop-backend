import { Module } from '@nestjs/common'
import { AdminRealtimeController, RealtimeController } from './realtime.controller.js'
import { RealtimeService } from './realtime.service.js'

/** Change notifications over SSE; the cache invalidator and the order stream publish/read here. */
@Module({
    controllers: [RealtimeController, AdminRealtimeController],
    providers: [RealtimeService],
    exports: [RealtimeService],
})
export class RealtimeModule {}
