/** Delivery attempts before a message is left `failed` for an admin to retry. */
export const OUTBOX_MAX_ATTEMPTS = 8

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/**
 * Wait after the 1st, 2nd, 3rd… failed attempt: quick retries for a blip, then spaced out for
 * an outage (the last value repeats). From the first failure to giving up: about a day.
 */
export const OUTBOX_RETRY_DELAYS_MS = [30 * SECOND, 2 * MINUTE, 10 * MINUTE, HOUR, 6 * HOUR]

/**
 * When to try again after `attempts` failed attempts, or null when they ran out (the message
 * becomes `failed`).
 */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
    if (attempts >= OUTBOX_MAX_ATTEMPTS) return null
    const index = Math.min(Math.max(attempts, 1), OUTBOX_RETRY_DELAYS_MS.length) - 1
    const delay = OUTBOX_RETRY_DELAYS_MS[index] ?? HOUR
    return new Date(now.getTime() + delay)
}
