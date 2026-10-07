import type { DataSource } from 'typeorm'

/**
 * Runs `work` only if no other session (another API instance, or an overlapping run of this
 * one) holds the Postgres advisory lock `name`; resolves false when it was skipped.
 *
 * Session-level lock on a dedicated connection, held until `work` settles: not a transaction
 * lock, so `work` can be long (a BCV request) or use transactions of its own without tripping
 * `idle_in_transaction_session_timeout`. Postgres releases it by itself if the connection dies.
 */
export async function runExclusive(
    dataSource: DataSource,
    name: string,
    work: () => Promise<void>,
): Promise<boolean> {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    try {
        const [row] = (await runner.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS "locked"`, [
            name,
        ])) as { locked: boolean }[]
        if (!row?.locked) return false
        try {
            await work()
        } finally {
            await runner.query(`SELECT pg_advisory_unlock(hashtext($1))`, [name])
        }
        return true
    } finally {
        await runner.release()
    }
}
