import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes -> 43 base64url characters. */
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** Compared against when there is no order, so a miss costs the same as a wrong token. */
const DUMMY_HASH = createHash('sha256').update('no-order').digest()

/**
 * Customers reach their order through a private link (`/pedido/KZ-000123?t=<token>`). Only the
 * SHA-256 of the token is stored, so a database leak does not leak working links.
 */
export function generateAccessToken(): { token: string; hash: string } {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    return { token, hash: hashAccessToken(token) }
}

export function hashAccessToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

/** Constant-time check of a presented token against one stored hash (hex). */
export function accessTokenMatches(token: unknown, storedHash: string | null | undefined): boolean {
    const valid = typeof token === 'string' && TOKEN_PATTERN.test(token)
    const expected =
        storedHash && /^[a-f0-9]{64}$/.test(storedHash)
            ? Buffer.from(storedHash, 'hex')
            : DUMMY_HASH
    const presented = createHash('sha256')
        .update(valid ? token : '')
        .digest()
    return timingSafeEqual(presented, expected) && valid && Boolean(storedHash)
}

/**
 * Whether the token opens any of the order's links (hashes of its non-revoked links). Every
 * candidate is compared in constant time and none is skipped after a match, so the time spent
 * only depends on how many links the order has. No candidates (unknown order) still costs one
 * comparison against a dummy hash.
 */
export function accessTokenMatchesAny(token: unknown, storedHashes: readonly string[]): boolean {
    if (!storedHashes.length) {
        accessTokenMatches(token, null)
        return false
    }
    let matched = false
    for (const hash of storedHashes) {
        if (accessTokenMatches(token, hash)) matched = true
    }
    return matched
}
