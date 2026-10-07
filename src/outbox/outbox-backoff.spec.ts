import { nextAttemptAt, OUTBOX_MAX_ATTEMPTS } from './outbox-backoff.js'

const NOW = new Date('2026-10-07T12:00:00Z')
const after = (attempts: number) => {
    const at = nextAttemptAt(attempts, NOW)
    return at === null ? null : (at.getTime() - NOW.getTime()) / 1000
}

describe('nextAttemptAt', () => {
    it('waits 30 s, 2 min, 10 min, 1 h, then 6 h between attempts', () => {
        expect([1, 2, 3, 4, 5, 6, 7].map(after)).toEqual([
            30, 120, 600, 3600, 21_600, 21_600, 21_600,
        ])
    })

    it('gives up after the last attempt', () => {
        expect(OUTBOX_MAX_ATTEMPTS).toBe(8)
        expect(after(OUTBOX_MAX_ATTEMPTS)).toBeNull()
        expect(after(OUTBOX_MAX_ATTEMPTS + 1)).toBeNull()
    })
})
