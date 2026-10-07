import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'
import type { Env } from '../config/env.schema.js'
import { createDataSourceOptions } from './database.options.js'

@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) => ({
                ...createDataSourceOptions(config.get('DATABASE_URL', { infer: true }), {
                    max: config.get('DB_POOL_MAX', { infer: true }),
                    statementTimeoutMs: config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
                    idleInTransactionTimeoutMs: config.get('DB_IDLE_TX_TIMEOUT_MS', {
                        infer: true,
                    }),
                    connectTimeoutMs: config.get('DB_CONNECT_TIMEOUT_MS', { infer: true }),
                }),
                retryAttempts: 5,
                retryDelay: 3000,
            }),
        }),
    ],
})
export class DatabaseModule {}
