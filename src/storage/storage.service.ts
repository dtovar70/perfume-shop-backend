import type { Readable } from 'node:stream'
import type { ImageType } from './image-type.js'

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE')

export interface UploadableImage {
    buffer: Buffer
    type: ImageType
}

export interface StoredFile {
    /** Public URL to render the file. */
    url: string
    /** Storage key used later to delete the file. */
    publicId: string
}

/** Folders of the public area: product photos and brand logos. */
export const PUBLIC_FOLDERS = ['products', 'brands'] as const
export type PublicFolder = (typeof PUBLIC_FOLDERS)[number]

/** Folders of the private area. Each one is a fixed, known prefix of the stored keys. */
export const PRIVATE_FOLDERS = ['payment-proofs'] as const
export type PrivateFolder = (typeof PRIVATE_FOLDERS)[number]

export interface StoredPrivateFile {
    /** Opaque storage key; the only way to read or delete the file later. Never a URL. */
    key: string
}

/**
 * How a private file is handed to an authorized reader: streamed by the API (local disk) or
 * through a short-lived signed URL the API redirects to (Cloudinary).
 */
export type PrivateFileAccess =
    | { kind: 'stream'; stream: Readable; contentType: string; size: number }
    | { kind: 'redirect'; url: string }

/** Image storage backend. Implementations: Cloudinary (production) or local disk (dev). */
export interface StorageService {
    readonly driver: 'cloudinary' | 'local'
    /** Public image, in `folder` (default `products`). */
    upload(image: UploadableImage, folder?: PublicFolder): Promise<StoredFile>
    delete(publicId: string): Promise<void>

    /**
     * Private files (e.g. payment screenshots with bank data). They are never publicly
     * reachable: local files live outside the statically served folder and Cloudinary assets
     * are uploaded as `authenticated`. Only an authenticated API route may read them.
     */
    uploadPrivate(image: UploadableImage, folder: PrivateFolder): Promise<StoredPrivateFile>
    /** Resolves to null when the key is unknown or the file is gone. */
    readPrivate(key: string): Promise<PrivateFileAccess | null>
    deletePrivate(key: string): Promise<void>
}
