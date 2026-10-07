import { Global, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AdminOutboxController } from './admin-outbox.controller.js'
import { OutboxMessage } from './entities/outbox-message.entity.js'
import { OutboxRegistry } from './outbox-handler.js'
import { OutboxService } from './outbox.service.js'
import { OutboxStore } from './outbox.store.js'
import { OutboxWorker } from './outbox.worker.js'

/**
 * Reliable notifications: the orders record outbox rows in their transactions (OutboxService),
 * the email and Telegram modules register the handlers (OutboxRegistry) and OutboxWorker
 * delivers. Global so both sides reach it without importing each other.
 */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([OutboxMessage])],
    controllers: [AdminOutboxController],
    providers: [OutboxRegistry, OutboxService, OutboxStore, OutboxWorker],
    exports: [OutboxRegistry, OutboxService],
})
export class OutboxModule {}
