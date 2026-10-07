import { OutboxRegistry, type OutboxHandler } from './outbox-handler.js'

const handler = (type: string, event: string, wants = true): OutboxHandler => ({
    type,
    event,
    wants: () => wants,
    handle: () => Promise.resolve(),
})

describe('OutboxRegistry', () => {
    it('lists the handlers of an event that want it', () => {
        const registry = new OutboxRegistry()
        registry.register(handler('email.received', 'order.created'))
        registry.register(handler('telegram.created', 'order.created'))
        registry.register(handler('telegram.off', 'order.created', false))
        registry.register(handler('telegram.payment', 'order.payment_submitted'))

        const types = registry
            .subscribers({ name: 'order.created', payload: {} })
            .map((subscriber) => subscriber.type)
        expect(types).toEqual(['email.received', 'telegram.created'])
        expect(registry.handler('telegram.payment')?.event).toBe('order.payment_submitted')
        expect(registry.handler('unknown')).toBeUndefined()
    })

    it('refuses two handlers with the same type', () => {
        const registry = new OutboxRegistry()
        registry.register(handler('email.received', 'order.created'))
        expect(() => registry.register(handler('email.received', 'order.created'))).toThrow(
            /registered twice/,
        )
    })
})
