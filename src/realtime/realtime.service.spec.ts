import type { MessageEvent } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { HEARTBEAT_MS, RealtimeService } from './realtime.service.js'

describe('RealtimeService', () => {
    /** Subscribes and collects what the client would receive; `done` turns true on completion. */
    function listen(stream: Observable<MessageEvent>) {
        const received: MessageEvent[] = []
        const state = { done: false }
        const subscription = stream.subscribe({
            next: (message) => received.push(message),
            complete: () => (state.done = true),
        })
        return { received, state, subscription }
    }

    function publishAll(service: RealtimeService) {
        service.publish({ type: 'catalog' })
        service.onOrderChanged({ code: 'KZ-000001' })
        service.publish({ type: 'exchange-rate' })
        service.onOrderChanged({ code: 'KZ-000002' })
    }

    it('the public stream carries the storefront changes and never an order', () => {
        const service = new RealtimeService()
        const { received } = listen(service.publicStream())
        publishAll(service)
        expect(received).toEqual([
            { data: { type: 'catalog' } },
            { data: { type: 'exchange-rate' } },
        ])
    })

    it("an order stream only carries that order's events", () => {
        const service = new RealtimeService()
        const { received } = listen(service.orderStream('KZ-000002'))
        publishAll(service)
        expect(received).toEqual([{ data: { type: 'order', code: 'KZ-000002' } }])
    })

    it('the admin stream carries everything', () => {
        const service = new RealtimeService()
        const { received } = listen(service.adminStream())
        publishAll(service)
        expect(received).toHaveLength(4)
    })

    describe('with fake timers', () => {
        beforeEach(() => vi.useFakeTimers())
        afterEach(() => vi.useRealTimers())

        it('sends a heartbeat comment while idle, and stops it on unsubscribe', () => {
            const service = new RealtimeService()
            const { received, subscription } = listen(service.orderStream('KZ-000001'))
            vi.advanceTimersByTime(HEARTBEAT_MS * 2)
            expect(received).toEqual([{ comment: 'ping' }, { comment: 'ping' }])

            subscription.unsubscribe()
            vi.advanceTimersByTime(HEARTBEAT_MS * 2)
            service.onOrderChanged({ code: 'KZ-000001' })
            expect(received).toHaveLength(2)
            expect(vi.getTimerCount()).toBe(0)
        })

        it('ends the admin stream when the session expires', () => {
            const service = new RealtimeService()
            const { state } = listen(service.adminStream(new Date(Date.now() + 60_000)))
            vi.advanceTimersByTime(59_000)
            expect(state.done).toBe(false)
            vi.advanceTimersByTime(1_000)
            expect(state.done).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        })
    })

    it('completes every stream on shutdown, even one opened afterwards', () => {
        const service = new RealtimeService()
        const before = listen(service.publicStream())
        service.onModuleDestroy()
        const after = listen(service.adminStream())
        expect(before.state.done).toBe(true)
        expect(after.state.done).toBe(true)
    })
})
