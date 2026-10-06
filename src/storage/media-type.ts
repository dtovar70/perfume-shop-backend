import { detectImageType, type ImageType } from './image-type.js'

/**
 * Media accepted for page content (the home hero): the product image formats plus AVIF, and
 * short MP4 / WebM videos. Like `detectImageType`, detection relies on the file signature, never
 * on the client-provided mimetype or file name.
 */
export type MediaImageType = ImageType | 'avif'
export type VideoType = 'mp4' | 'webm'
export type MediaType = MediaImageType | VideoType
export type MediaKind = 'image' | 'video'

export const MEDIA_EXTENSIONS: Record<MediaType, string> = {
    jpeg: 'jpg',
    png: 'png',
    webp: 'webp',
    avif: 'avif',
    mp4: 'mp4',
    webm: 'webm',
}

/** Mimetypes the upload filter lets through; the signature check runs afterwards. */
export const ALLOWED_MEDIA_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
])
export const ALLOWED_MEDIA_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm'])

/** File extensions this module produces, by kind. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm'])

export function mediaKind(type: MediaType): MediaKind {
    return type === 'mp4' || type === 'webm' ? 'video' : 'image'
}

/** Kind of a stored file from its extension ("abc.mp4" -> video). */
export function mediaKindOfExtension(extension: string): MediaKind {
    return VIDEO_EXTENSIONS.has(extension.toLowerCase()) ? 'video' : 'image'
}

/** ISO base media brands (`ftyp`) of playable MP4 files; QuickTime (`qt  `) is not one. */
const MP4_BRANDS = new Set([
    'isom',
    'iso2',
    'iso3',
    'iso4',
    'iso5',
    'iso6',
    'mp41',
    'mp42',
    'avc1',
    'M4V ',
    'M4VP',
    'dash',
    'mmp4',
    'MSNV',
    'f4v ',
])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/** Brands of an ISO BMFF `ftyp` box (major + compatible), or null when there is none. */
function ftypBrands(buffer: Buffer): { major: string; compatible: string[] } | null {
    if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') return null
    const boxSize = buffer.readUInt32BE(0)
    const end = Math.min(buffer.length, boxSize >= 16 ? boxSize : 16, 64)
    const compatible: string[] = []
    for (let offset = 16; offset + 4 <= end; offset += 4) {
        compatible.push(buffer.toString('ascii', offset, offset + 4))
    }
    return { major: buffer.toString('ascii', 8, 12), compatible }
}

/** EBML header (Matroska family) whose DocType is "webm". */
function isWebm(buffer: Buffer): boolean {
    if (buffer.length < 4) return false
    if (!buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false
    // The DocType element (0x4282) sits inside the header, within the first few dozen bytes.
    const header = buffer.subarray(0, 64)
    const docType = header.indexOf(Buffer.from([0x42, 0x82]))
    return docType !== -1 && header.indexOf('webm', docType, 'ascii') !== -1
}

export function detectMediaType(buffer: Buffer): MediaType | null {
    const image = detectImageType(buffer)
    if (image) return image
    if (isWebm(buffer)) return 'webm'

    const brands = ftypBrands(buffer)
    if (!brands) return null
    if (AVIF_BRANDS.has(brands.major)) return 'avif'
    // Some encoders write a generic major brand ("mif1") and list "avif" as compatible.
    if (brands.major === 'mif1' && brands.compatible.some((brand) => AVIF_BRANDS.has(brand))) {
        return 'avif'
    }
    if (MP4_BRANDS.has(brands.major)) return 'mp4'
    return null
}
