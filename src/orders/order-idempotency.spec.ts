import { BadRequestException } from '@nestjs/common'
import { QueryFailedError } from 'typeorm'
import type { CreateOrderDto } from './dto/create-order.dto.js'
import {
    canonicalJson,
    checkoutRequestHash,
    isIdempotencyKeyConflict,
    parseIdempotencyKey,
} from './order-idempotency.js'

const DTO = {
    fullName: 'Ana Pérez',
    email: 'ana@example.com',
    phone: '0414-1234567',
    city: 'Caracas',
    address: 'Av. Principal',
    deliveryMethod: 'delivery',
    items: [{ productId: 'perfume-001', variantId: 'v-15oz', quantity: 2 }],
} as unknown as CreateOrderDto

describe('order idempotency', () => {
    it('accepts UUIDs and similar keys; treats an empty header as absent', () => {
        expect(parseIdempotencyKey(undefined)).toBeUndefined()
        expect(parseIdempotencyKey('  ')).toBeUndefined()
        expect(parseIdempotencyKey('3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')).toBe(
            '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        )
        expect(() => parseIdempotencyKey('too-short')).toThrow(BadRequestException)
        expect(() => parseIdempotencyKey('a'.repeat(65))).toThrow(BadRequestException)
        expect(() => parseIdempotencyKey('3f1c2d4e_5a6b_4c7d_8e9f')).toThrow(BadRequestException)
    })

    it('serializes with sorted keys and without undefined', () => {
        expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 'x' }], e: null })).toBe(
            '{"a":[{"c":"x"}],"b":1,"e":null}',
        )
    })

    it('hashes the same request the same way, and a different one differently', () => {
        const hash = checkoutRequestHash(DTO)
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
        expect(checkoutRequestHash({ ...DTO, email: 'ANA@example.com', notes: '' })).toBe(hash)
        expect(checkoutRequestHash({ ...DTO, city: 'Valencia' })).not.toBe(hash)
        expect(
            checkoutRequestHash({
                ...DTO,
                items: [{ productId: 'perfume-001', variantId: 'v-15oz', quantity: 3 }],
            }),
        ).not.toBe(hash)
    })

    it('recognizes only the unique violation of the key index', () => {
        const violation = (constraint: string) =>
            new QueryFailedError('INSERT', [], {
                code: '23505',
                constraint,
            } as unknown as Error)
        expect(isIdempotencyKeyConflict(violation('orders_idempotency_key_key'))).toBe(true)
        expect(isIdempotencyKeyConflict(violation('orders_code_key'))).toBe(false)
        expect(isIdempotencyKeyConflict(new Error('boom'))).toBe(false)
    })
})
