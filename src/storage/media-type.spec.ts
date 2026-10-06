import { detectMediaType, mediaKind } from './media-type.js'

function ftyp(major: string, ...compatible: string[]): Buffer {
    const brands = Buffer.from([major, '\0\0\0\0', ...compatible].join(''), 'binary')
    const size = Buffer.alloc(4)
    size.writeUInt32BE(8 + brands.length)
    return Buffer.concat([size, Buffer.from('ftyp'), brands, Buffer.alloc(16)])
}

const WEBM = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
])

describe('detectMediaType', () => {
    it('keeps detecting the product image formats', () => {
        expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
        expect(detectMediaType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary'))).toBe('webp')
    })

    it('detects AVIF, MP4 and WebM signatures', () => {
        expect(detectMediaType(ftyp('avif', 'mif1', 'miaf'))).toBe('avif')
        expect(detectMediaType(ftyp('mif1', 'avif'))).toBe('avif')
        expect(detectMediaType(ftyp('isom', 'iso2', 'avc1', 'mp41'))).toBe('mp4')
        expect(detectMediaType(ftyp('mp42', 'isom'))).toBe('mp4')
        expect(detectMediaType(WEBM)).toBe('webm')
        expect(mediaKind('webm')).toBe('video')
        expect(mediaKind('avif')).toBe('image')
    })

    it('rejects other containers and look-alikes', () => {
        expect(detectMediaType(ftyp('qt  '))).toBeNull()
        expect(detectMediaType(ftyp('heic', 'mif1'))).toBeNull()
        // Matroska that is not WebM.
        expect(
            detectMediaType(Buffer.from([...WEBM.subarray(0, 12), 0x6d, 0x6b, 0x76, 0x20])),
        ).toBeNull()
        expect(detectMediaType(Buffer.from('GIF89a'))).toBeNull()
        expect(detectMediaType(Buffer.alloc(0))).toBeNull()
    })
})
