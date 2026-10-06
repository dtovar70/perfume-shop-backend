import { QueryFailedError } from 'typeorm'

/** Postgres error codes: 23505 = unique violation, 23503 = foreign key violation. */
export type PgErrorCode = '23505' | '23503'

export function isDbError(error: unknown, code: PgErrorCode): boolean {
    if (!(error instanceof QueryFailedError)) return false
    const driverError = error.driverError as { code?: unknown } | undefined
    return driverError?.code === code
}

/** Name of the constraint a database error broke, when Postgres reports one. */
export function dbConstraint(error: unknown): string | undefined {
    if (!(error instanceof QueryFailedError)) return undefined
    const driverError = error.driverError as { constraint?: unknown } | undefined
    return typeof driverError?.constraint === 'string' ? driverError.constraint : undefined
}

/** Returns a copy without `undefined` values, so partial updates only touch sent fields. */
export function omitUndefined<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as Partial<T>
}
