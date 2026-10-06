import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import { IMAGE_EXTENSIONS } from './image-type.js'
import { MEDIA_EXTENSIONS, mediaKindOfExtension } from './media-type.js'
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

/** Root folder for local uploads, served statically at `/uploads` (see main.ts). */
export const LOCAL_UPLOADS_DIR = join(process.cwd(), 'uploads')

/**
 * Root folder for private files. Deliberately a sibling of `uploads/`, never inside it, so no
 * static route can ever serve it; files are only streamed by authenticated API routes.
 */
export const LOCAL_PRIVATE_UPLOADS_DIR = join(process.cwd(), 'private-uploads')

const SAFE_PUBLIC_ID = /^(products|brands)\/[a-f0-9-]{36}\.(jpg|png|webp)$/
/** Keys of page media this service creates (`hero/<uuid>.<ext>`). */
const SAFE_MEDIA_ID = /^(hero)\/[a-f0-9-]{36}\.(jpg|png|webp|avif|mp4|webm)$/
/** Keys this service creates for private files; anything else is refused (path traversal). */
const SAFE_PRIVATE_KEY = /^(payment-proofs)\/[a-f0-9-]{36}\.(jpg|png|webp)$/

const CONTENT_TYPES: Record<string, string> = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
}

/** Development fallback used when Cloudinary is not configured. */
export class LocalStorageService implements StorageService {
    readonly driver = 'local' as const
    private readonly logger = new Logger(LocalStorageService.name)

    constructor(
        private readonly publicApiUrl: string,
        private readonly privateDir: string = LOCAL_PRIVATE_UPLOADS_DIR,
    ) {}

    /**
     * Served by `useStaticAssets` after the app-wide CORS middleware, so the storefront origin
     * gets `Access-Control-Allow-Origin` and can draw these images on a canvas too.
     */
    async upload(image: UploadableImage, folder: PublicFolder = 'products'): Promise<StoredFile> {
        const directory = join(LOCAL_UPLOADS_DIR, folder)
        await mkdir(directory, { recursive: true })

        const fileName = `${randomUUID()}.${IMAGE_EXTENSIONS[image.type]}`
        await writeFile(join(directory, fileName), image.buffer)

        const publicId = `${folder}/${fileName}`
        return { url: `${this.publicApiUrl}/uploads/${publicId}`, publicId }
    }

    async delete(publicId: string): Promise<void> {
        // Guard against path traversal: only delete files this service created.
        if (!SAFE_PUBLIC_ID.test(publicId)) {
            this.logger.warn(`Refusing to delete unexpected local file key "${publicId}"`)
            return
        }
        try {
            await unlink(join(LOCAL_UPLOADS_DIR, publicId))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }

    async uploadMedia(media: UploadableMedia, folder: MediaFolder): Promise<StoredFile> {
        const directory = join(LOCAL_UPLOADS_DIR, folder)
        await mkdir(directory, { recursive: true })

        const fileName = `${randomUUID()}.${MEDIA_EXTENSIONS[media.type]}`
        await writeFile(join(directory, fileName), media.buffer)

        const publicId = `${folder}/${fileName}`
        return { url: `${this.publicApiUrl}/uploads/${publicId}`, publicId }
    }

    mediaFromUrl(url: string, folder: MediaFolder): StoredMediaRef | null {
        const prefix = `${this.publicApiUrl}/uploads/`
        if (!url.startsWith(prefix)) return null
        const publicId = url.slice(prefix.length)
        if (!SAFE_MEDIA_ID.test(publicId) || !publicId.startsWith(`${folder}/`)) return null
        return {
            publicId,
            kind: mediaKindOfExtension(publicId.slice(publicId.lastIndexOf('.') + 1)),
        }
    }

    async deleteMedia(media: StoredMediaRef): Promise<void> {
        if (!SAFE_MEDIA_ID.test(media.publicId)) {
            this.logger.warn(`Refusing to delete unexpected local media key "${media.publicId}"`)
            return
        }
        try {
            await unlink(join(LOCAL_UPLOADS_DIR, media.publicId))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }

    async uploadPrivate(image: UploadableImage, folder: PrivateFolder): Promise<StoredPrivateFile> {
        const directory = join(this.privateDir, folder)
        await mkdir(directory, { recursive: true, mode: 0o700 })

        const fileName = `${randomUUID()}.${IMAGE_EXTENSIONS[image.type]}`
        await writeFile(join(directory, fileName), image.buffer, { mode: 0o600 })
        return { key: `${folder}/${fileName}` }
    }

    async readPrivate(key: string): Promise<PrivateFileAccess | null> {
        if (!SAFE_PRIVATE_KEY.test(key)) return null
        const path = join(this.privateDir, key)
        try {
            const info = await stat(path)
            const extension = key.slice(key.lastIndexOf('.') + 1)
            return {
                kind: 'stream',
                stream: createReadStream(path),
                contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
                size: info.size,
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
    }

    async deletePrivate(key: string): Promise<void> {
        if (!SAFE_PRIVATE_KEY.test(key)) {
            this.logger.warn(`Refusing to delete unexpected private file key "${key}"`)
            return
        }
        try {
            await unlink(join(this.privateDir, key))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }
}
