import { readFileSync } from 'node:fs'
import { parseBcvHtml } from './bcv.provider.js'
import { parseBinanceP2pJson } from './binance.provider.js'
import { parseDolarApiJson } from './dolarapi.provider.js'

const fixture = (name: string) =>
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

describe('parseBcvHtml', () => {
    it('reads the USD rate (not the EUR/CNY ones above it) and the fecha valor', () => {
        expect(parseBcvHtml(fixture('bcv-home.html'))).toEqual({
            rate: 854.4637,
            effectiveDate: '2026-09-24',
        })
    })

    it('reads the EUR rate from its own block, with the same fecha valor', () => {
        expect(parseBcvHtml(fixture('bcv-home.html'), 'EUR')).toEqual({
            rate: 974.063,
            effectiveDate: '2026-09-24',
        })
    })

    it('handles thousands separators', () => {
        const html =
            '<div id="dolar"><strong class="strong-tb"> 1.234,56780000</strong></div>' +
            'Fecha Valor: <span content="2026-10-01T00:00:00-04:00">x</span>'
        expect(parseBcvHtml(html)).toEqual({ rate: 1234.5678, effectiveDate: '2026-10-01' })
    })

    it('fails loudly when the page changed', () => {
        expect(() => parseBcvHtml('<html>mantenimiento</html>')).toThrow(/USD block/)
        expect(() => parseBcvHtml('<div id="dolar"><strong>abc</strong></div>')).toThrow(/rate/)
        expect(() => parseBcvHtml('<div id="dolar"><strong>0,00000000</strong></div>')).toThrow(
            /implausible/,
        )
        expect(() => parseBcvHtml('<div id="dolar"><strong>854,46</strong></div>')).toThrow(
            /fecha valor/,
        )
        expect(() => parseBcvHtml('<div id="dolar"><strong>854,46</strong></div>', 'EUR')).toThrow(
            /EUR block/,
        )
    })
})

describe('parseDolarApiJson', () => {
    it('reads `promedio` and the Caracas day of `fechaActualizacion`', () => {
        expect(parseDolarApiJson(JSON.parse(fixture('dolarapi-oficial.json')))).toEqual({
            rate: 854.4637,
            effectiveDate: '2026-09-24',
        })
    })

    it('reads the official euro rate from the euro endpoint', () => {
        const euro = JSON.parse(fixture('dolarapi-euro.json')) as unknown
        expect(parseDolarApiJson(euro, 'EUR')).toEqual({
            rate: 974.063,
            effectiveDate: '2026-09-24',
        })
        // A dollar answer is never taken as the euro rate (or the other way around).
        expect(() => parseDolarApiJson(euro, 'USD')).toThrow(/official USD/)
        expect(() =>
            parseDolarApiJson(JSON.parse(fixture('dolarapi-oficial.json')), 'EUR'),
        ).toThrow(/official EUR/)
    })

    it('converts a UTC stamp to the Caracas calendar day', () => {
        const payload = {
            moneda: 'USD',
            fuente: 'oficial',
            promedio: 850.1,
            fechaActualizacion: '2026-09-25T02:00:00.000Z',
        }
        expect(parseDolarApiJson(payload)).toEqual({ rate: 850.1, effectiveDate: '2026-09-24' })
    })

    it('rejects the parallel rate and malformed payloads', () => {
        const base = JSON.parse(fixture('dolarapi-oficial.json')) as Record<string, unknown>
        expect(() => parseDolarApiJson({ ...base, fuente: 'paralelo' })).toThrow(/official/)
        expect(() => parseDolarApiJson({ ...base, promedio: null })).toThrow(/implausible/)
        expect(() => parseDolarApiJson({ ...base, fechaActualizacion: 'ayer' })).toThrow(/fecha/)
        expect(() => parseDolarApiJson('nope')).toThrow()
    })
})

describe('parseBinanceP2pJson', () => {
    const now = new Date('2026-10-28T03:30:00Z')
    const payload = () => JSON.parse(fixture('binance-p2p.json')) as { data: unknown[] }
    const ads = (...prices: string[]) => ({
        code: '000000',
        success: true,
        data: prices.map((price) => ({ adv: { asset: 'USDT', fiatUnit: 'VES', price } })),
    })

    it('takes the median ad price, dated the Caracas day it was read', () => {
        // Ten ads: the cheap 980,54 outlier does not move the median of 1007,5 and 1007,9.
        expect(parseBinanceP2pJson(payload(), now)).toEqual({
            rate: 1007.7,
            effectiveDate: '2026-10-27',
        })
        expect(parseBinanceP2pJson(ads('10', '1000', '1001'), now).rate).toBe(1000)
    })

    it('rejects too few ads, bad prices and error answers', () => {
        expect(() => parseBinanceP2pJson(ads('1000', '1001'), now)).toThrow(/only 2 ads/)
        expect(() => parseBinanceP2pJson(ads('1000', '1001', '0'), now)).toThrow(/invalid/)
        expect(() => parseBinanceP2pJson(ads('1000', '1001', 'abc'), now)).toThrow(/invalid/)
        expect(() => parseBinanceP2pJson(ads('1e9', '1e9', '1e9'), now)).toThrow(/implausible/)
        expect(() => parseBinanceP2pJson({ code: '100001', data: null }, now)).toThrow(/unexpected/)
        expect(() => parseBinanceP2pJson('nope', now)).toThrow()
    })

    it('ignores ads of another asset or fiat', () => {
        const body = ads('1000', '1001', '1002')
        body.data.push({ adv: { asset: 'BTC', fiatUnit: 'VES', price: '9' } })
        expect(parseBinanceP2pJson(body, now).rate).toBe(1001)
    })
})
