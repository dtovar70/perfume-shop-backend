import jsqr from 'jsqr'
import { PNG } from 'pngjs'
import { orderQrPng } from './order-qr.js'

/** Decodes a QR PNG the way a phone camera would (RGBA pixels -> text). */
function decodeQrPng(png: Buffer): string | null {
    const image = PNG.sync.read(png)
    const pixels = new Uint8ClampedArray(
        image.data.buffer,
        image.data.byteOffset,
        image.data.length,
    )
    return jsqr.default(pixels, image.width, image.height)?.data ?? null
}

const URL_WITH_TOKEN =
    'https://kaizen.com/pedido/KZ-000012?t=Q2hvY29sYXRlLWNha2UtaXMtdGhlLWJlc3QtY2FrZS0x'

describe('order QR', () => {
    it('renders a PNG that decodes back to the private order link', async () => {
        const png = await orderQrPng(URL_WITH_TOKEN)
        expect(png.subarray(1, 4).toString()).toBe('PNG')
        expect(decodeQrPng(png)).toBe(URL_WITH_TOKEN)
    })

    it('is dark on white with a quiet zone around the symbol', async () => {
        const image = PNG.sync.read(await orderQrPng(URL_WITH_TOKEN, 480))
        expect(image.width).toBe(480)
        const pixel = (x: number, y: number) => image.data.readUInt32BE((y * image.width + x) * 4)
        // Corners and the whole first rows are the white quiet zone.
        for (let x = 0; x < image.width; x += 7) {
            expect(pixel(x, 0)).toBe(0xffffffff)
            expect(pixel(x, 10)).toBe(0xffffffff)
        }
        // Every pixel is pure black or pure white.
        const colors = new Set<number>()
        for (let offset = 0; offset < image.data.length; offset += 4) {
            colors.add(image.data.readUInt32BE(offset))
        }
        expect([...colors].sort()).toEqual([0x000000ff, 0xffffffff])
    })

    it('still decodes at the small size printed on the receipt', async () => {
        expect(decodeQrPng(await orderQrPng(URL_WITH_TOKEN, 200))).toBe(URL_WITH_TOKEN)
    })
})
