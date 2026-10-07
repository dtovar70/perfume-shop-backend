import { Role } from '../auth/role.enum.js'
import {
    allowedTransitions,
    checkTransition,
    invalidTransitionMessage,
    ORDER_STATUSES,
    ORDER_TRANSITIONS,
    type OrderActor,
    type OrderStatus,
} from './order-status.js'

const ADMIN: OrderActor = { kind: 'admin', userId: 'u1', role: Role.ADMIN }
const EDITOR: OrderActor = { kind: 'admin', userId: 'u2', role: Role.EDITOR }
const CUSTOMER: OrderActor = { kind: 'customer' }
const SYSTEM: OrderActor = { kind: 'system' }
const TELEGRAM: OrderActor = { kind: 'telegram' }

describe('order transition map', () => {
    it('lets a payment be recorded while due, after a rejection or once expired', () => {
        for (const from of ['PENDIENTE_PAGO', 'PAGO_RECHAZADO', 'EXPIRADO'] as const) {
            for (const actor of [CUSTOMER, ADMIN, EDITOR]) {
                const check = checkTransition(from, 'PENDIENTE_VERIFICACION', actor)
                expect(check.ok && check.rule.requiresPayment).toBe(true)
            }
            expect(checkTransition(from, 'PENDIENTE_VERIFICACION', TELEGRAM).ok).toBe(false)
        }
        expect(checkTransition('PAGO_VERIFICADO', 'PENDIENTE_VERIFICACION', CUSTOMER)).toEqual({
            ok: false,
            reason: 'invalid',
        })
    })

    it('takes the stock back when a late payment arrives on an expired order', () => {
        const late = checkTransition('EXPIRADO', 'PENDIENTE_VERIFICACION', CUSTOMER)
        expect(late.ok && late.rule.reservesStock && !late.rule.reactivates).toBe(true)
        const onTime = checkTransition('PENDIENTE_PAGO', 'PENDIENTE_VERIFICACION', CUSTOMER)
        expect(onTime.ok && onTime.rule.reservesStock).toBeFalsy()
    })

    it('keeps a cancelled order closed to customer payments', () => {
        expect(checkTransition('CANCELADO', 'PENDIENTE_VERIFICACION', CUSTOMER)).toEqual({
            ok: false,
            reason: 'invalid',
        })
        expect(checkTransition('CANCELADO', 'PENDIENTE_VERIFICACION', ADMIN).ok).toBe(false)
    })

    it('reactivates an expired order (staff) or a never-paid cancelled one (ADMIN only)', () => {
        for (const actor of [ADMIN, EDITOR]) {
            const expired = checkTransition('EXPIRADO', 'PENDIENTE_PAGO', actor)
            expect(expired.ok && expired.rule.reactivates && expired.rule.reservesStock).toBe(true)
        }
        expect(checkTransition('EXPIRADO', 'PENDIENTE_PAGO', CUSTOMER).ok).toBe(false)
        expect(checkTransition('EXPIRADO', 'PENDIENTE_PAGO', TELEGRAM).ok).toBe(false)

        const cancelled = checkTransition('CANCELADO', 'PENDIENTE_PAGO', ADMIN)
        expect(cancelled.ok && cancelled.rule.requiresNoVerifiedPayment).toBe(true)
        expect(checkTransition('CANCELADO', 'PENDIENTE_PAGO', EDITOR)).toEqual({
            ok: false,
            reason: 'forbidden',
        })
    })

    it('lets staff (admin or the Telegram bot) verify or reject a payment', () => {
        for (const actor of [ADMIN, EDITOR, TELEGRAM]) {
            expect(checkTransition('PENDIENTE_VERIFICACION', 'PAGO_VERIFICADO', actor).ok).toBe(
                true,
            )
            const reject = checkTransition('PENDIENTE_VERIFICACION', 'PAGO_RECHAZADO', actor)
            expect(reject.ok && reject.rule.requiresReason).toBe(true)
        }
        expect(checkTransition('PENDIENTE_VERIFICACION', 'PAGO_VERIFICADO', CUSTOMER).ok).toBe(
            false,
        )
    })

    it('follows the fulfilment steps in order', () => {
        const path = [
            'PAGO_VERIFICADO',
            'EN_PRODUCCION',
            'LISTO_PARA_ENTREGA',
            'ENVIADO',
            'ENTREGADO',
        ] as const
        let from: OrderStatus = path[0]
        for (const to of path.slice(1)) {
            expect(checkTransition(from, to, EDITOR).ok).toBe(true)
            from = to
        }
        expect(checkTransition('LISTO_PARA_ENTREGA', 'ENTREGADO', EDITOR).ok).toBe(true)
        expect(checkTransition('PAGO_VERIFICADO', 'ENVIADO', ADMIN)).toEqual({
            ok: false,
            reason: 'invalid',
        })
    })

    it('reserves cancelling for ADMIN, with a reason, restoring stock unless shipped', () => {
        const cancel = checkTransition('EN_PRODUCCION', 'CANCELADO', ADMIN)
        expect(cancel.ok && cancel.rule.requiresReason && cancel.rule.restoresStock).toBe(true)
        expect(checkTransition('EN_PRODUCCION', 'CANCELADO', EDITOR)).toEqual({
            ok: false,
            reason: 'forbidden',
        })
        const shipped = checkTransition('ENVIADO', 'CANCELADO', ADMIN)
        expect(shipped.ok && shipped.rule.restoresStock).toBe(false)
        expect(checkTransition('ENTREGADO', 'CANCELADO', ADMIN).ok).toBe(false)
    })

    it('only lets the scheduler expire unpaid orders, restoring their stock', () => {
        const expire = checkTransition('PENDIENTE_PAGO', 'EXPIRADO', SYSTEM)
        expect(expire.ok && expire.rule.restoresStock).toBe(true)
        expect(checkTransition('PENDIENTE_PAGO', 'EXPIRADO', ADMIN).ok).toBe(false)
        expect(checkTransition('PENDIENTE_VERIFICACION', 'EXPIRADO', SYSTEM).ok).toBe(false)
    })

    it('has a terminal status, reopens closed ones only by reactivation, only known targets', () => {
        expect(ORDER_TRANSITIONS.ENTREGADO).toEqual([])
        expect(ORDER_TRANSITIONS.CANCELADO.map((rule) => rule.to)).toEqual(['PENDIENTE_PAGO'])
        expect(ORDER_TRANSITIONS.EXPIRADO.map((rule) => rule.to)).toEqual([
            'PENDIENTE_VERIFICACION',
            'PENDIENTE_PAGO',
        ])
        for (const rules of Object.values(ORDER_TRANSITIONS)) {
            for (const rule of rules) expect(ORDER_STATUSES).toContain(rule.to)
        }
    })

    it('lists the actions an EDITOR sees (no cancel, manual payment where one is due)', () => {
        expect(allowedTransitions('PENDIENTE_PAGO', EDITOR).map((rule) => rule.to)).toEqual([
            'PENDIENTE_VERIFICACION',
        ])
        expect(allowedTransitions('EXPIRADO', EDITOR).map((rule) => rule.to)).toEqual([
            'PENDIENTE_VERIFICACION',
            'PENDIENTE_PAGO',
        ])
        expect(allowedTransitions('CANCELADO', EDITOR)).toEqual([])
        expect(allowedTransitions('PENDIENTE_VERIFICACION', EDITOR).map((rule) => rule.to)).toEqual(
            ['PAGO_VERIFICADO', 'PAGO_RECHAZADO'],
        )
        expect(allowedTransitions('PENDIENTE_VERIFICACION', ADMIN).map((rule) => rule.to)).toEqual([
            'PAGO_VERIFICADO',
            'PAGO_RECHAZADO',
            'CANCELADO',
        ])
    })

    it('explains an invalid move in Spanish', () => {
        const labels: Partial<Record<string, string>> = {
            ENTREGADO: 'Entregado',
            EN_PRODUCCION: 'En producción',
        }
        expect(
            invalidTransitionMessage('ENTREGADO', 'EN_PRODUCCION', (code) => labels[code] ?? code),
        ).toBe('No se puede pasar un pedido de «Entregado» a «En producción».')
    })
})
