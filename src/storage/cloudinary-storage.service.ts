import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary'
import { mediaKind } from './media-type.js'
import type {
    MediaFolder,
    PrivateFileAccess,
    PrivateFolder,
    PublicFolder,
    StorageService,
    StoredFile,
    StoredMediaRef,
    StoredPrivateFile,
    UploadableImage,
    UploadableMedia,
} from './storage.service.js'

export interface CloudinaryCredentials {
    cloudName: string
    apiKey: string
    apiSecret: string
}

const PUBLIC_ROOT = 'kaizen'
const PRIVATE_ROOT = 'kaizen/private'
/** Lifetime of the signed URL an admin is redirected to when opening a private file. */
const PRIVATE_URL_TTL_SECONDS = 5 * 60
/** `<folder>/<public_id>.<format>`, as built by `uploadPrivate`. */
const PRIVATE_KEY = /^kaizen\/private\/(payment-proofs)\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/
/**
 * Socket inactivity limits per call (the SDK only reads `timeout` per request, not from the
 * global config; its default is 60 s). An upload streams the file, so it gets more room than a
 * delete; either way a stalled Cloudinary never holds an admin request (and its DB connection
 * slot) for long.
 */
const UPLOAD_TIMEOUT_MS = 30_000
const DESTROY_TIMEOUT = { timeout: 10_000 }

function uploadBuffer(
    buffer: Buffer,
    options: Record<string, unknown>,
): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { ...options, timeout: UPLOAD_TIMEOUT_MS },
            (error, result?: UploadApiResponse) => {
                if (error || !result) {
                    reject(new Error(error?.message ?? 'Cloudinary upload failed'))
                    return
                }
                resolve(result)
            },
        )
        stream.end(buffer)
    })
}

/** "folder/abc.jpg" -> { publicId: "folder/abc", format: "jpg" } */
function splitKey(key: string): { publicId: string; format: string } {
    const dot = key.lastIndexOf('.')
    return { publicId: key.slice(0, dot), format: key.slice(dot + 1) }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class CloudinaryStorageService implements StorageService {
    readonly driver = 'cloudinary' as const
    /** `https://res.cloudinary.com/<cloud>/<image|video>/upload/v123/kaizen/<folder>/<id>.<ext>` */
    private readonly mediaUrl: RegExp

    constructor(credentials: CloudinaryCredentials) {
        this.mediaUrl = new RegExp(
            `^https://res\\.cloudinary\\.com/${escapeRegExp(credentials.cloudName)}/(image|video)/upload/(?:v\\d+/)?(${PUBLIC_ROOT}/([a-z-]+)/[A-Za-z0-9_-]+)\\.[a-z0-9]+$`,
        )
        cloudinary.config({
            cloud_name: credentials.cloudName,
            api_key: credentials.apiKey,
            api_secret: credentials.apiSecret,
            secure: true,
        })
    }

    /**
     * Public delivery (`res.cloudinary.com`) answers with `Access-Control-Allow-Origin: *`, so
     * the storefront can also draw these images on a canvas (loaded with `crossOrigin="anonymous"`).
     */
    async upload(image: UploadableImage, folder: PublicFolder = 'products'): Promise<StoredFile> {
        const result = await uploadBuffer(image.buffer, {
            folder: `${PUBLIC_ROOT}/${folder}`,
            resource_type: 'image',
        })
        return { url: result.secure_url, publicId: result.public_id }
    }

    async delete(publicId: string): Promise<void> {
        await cloudinary.uploader.destroy(publicId, {
            resource_type: 'image',
            invalidate: true,
            ...DESTROY_TIMEOUT,
        })
    }

    /** Videos are a separate Cloudinary resource type (`video`), with their own delivery URLs. */
    async uploadMedia(media: UploadableMedia, folder: MediaFolder): Promise<StoredFile> {
        const result = await uploadBuffer(media.buffer, {
            folder: `${PUBLIC_ROOT}/${folder}`,
            resource_type: mediaKind(media.type),
        })
        return { url: result.secure_url, publicId: result.public_id }
    }

    mediaFromUrl(url: string, folder: MediaFolder): StoredMediaRef | null {
        const match = this.mediaUrl.exec(url)
        if (!match || match[3] !== folder) return null
        return { publicId: match[2] ?? '', kind: match[1] === 'video' ? 'video' : 'image' }
    }

    async deleteMedia(media: StoredMediaRef): Promise<void> {
        await cloudinary.uploader.destroy(media.publicId, {
            resource_type: media.kind,
            invalidate: true,
            ...DESTROY_TIMEOUT,
        })
    }

    /**
     * `type: 'authenticated'` assets cannot be fetched by their plain delivery URL; they are
     * only reachable through URLs signed with the API secret.
     */
    async uploadPrivate(image: UploadableImage, folder: PrivateFolder): Promise<StoredPrivateFile> {
        const result = await uploadBuffer(image.buffer, {
            folder: `${PRIVATE_ROOT}/${folder}`,
            resource_type: 'image',
            type: 'authenticated',
        })
        return { key: `${result.public_id}.${result.format}` }
    }

    readPrivate(key: string): Promise<PrivateFileAccess | null> {
        if (!PRIVATE_KEY.test(key)) return Promise.resolve(null)
        const { publicId, format } = splitKey(key)
        // A download URL signed for a few minutes: it stops working soon after the admin looks.
        const url = cloudinary.utils.private_download_url(publicId, format, {
            resource_type: 'image',
            type: 'authenticated',
            expires_at: Math.floor(Date.now() / 1000) + PRIVATE_URL_TTL_SECONDS,
        })
        return Promise.resolve({ kind: 'redirect', url })
    }

    async deletePrivate(key: string): Promise<void> {
        if (!PRIVATE_KEY.test(key)) return
        const { publicId } = splitKey(key)
        await cloudinary.uploader.destroy(publicId, {
            resource_type: 'image',
            type: 'authenticated',
            invalidate: true,
            ...DESTROY_TIMEOUT,
        })
    }
}
