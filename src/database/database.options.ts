import type { DataSourceOptions } from 'typeorm'
import { ENTITIES } from './entities.js'

/** node-postgres pool size and the server-side limits every pooled connection starts with. */
export interface DatabasePoolSettings {
    /** Connections the pool may open. */
    max: number
    /** A single statement running longer than this is cancelled by Postgres. */
    statementTimeoutMs: number
    /** A transaction left idle (e.g. a request that died mid-way) is closed, releasing its locks. */
    idleInTransactionTimeoutMs: number
    /** How long to wait for a free connection (or a new one) before failing the request. */
    connectTimeoutMs: number
}

/**
 * Options shared by the Nest app and the CLI DataSource.
 * `synchronize` must stay false: the schema only changes through reviewed migrations.
 *
 * `pool` is only passed by the app: the CLI (migrations) keeps Postgres' defaults so a slow
 * DDL statement, such as building an index on a large table, is never cut by the API's
 * per-request statement timeout.
 */
export function createDataSourceOptions(
    url: string,
    pool?: DatabasePoolSettings,
): DataSourceOptions {
    return {
        type: 'postgres',
        url,
        entities: ENTITIES,
        synchronize: false,
        migrationsRun: false,
        migrationsTableName: 'typeorm_migrations',
        ...(pool && {
            extra: {
                max: pool.max,
                statement_timeout: pool.statementTimeoutMs,
                idle_in_transaction_session_timeout: pool.idleInTransactionTimeoutMs,
                connectionTimeoutMillis: pool.connectTimeoutMs,
            },
        }),
    }
}
