import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { LocalStorageService } from './local-storage.service.js'

async function readAll(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
}

describe('LocalStorageService private files', () => {
    let dir: string
    let storage: LocalStorageService

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'kz-private-'))
        storage = new LocalStorageService('http://localhost:3000', dir)
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('stores outside the public folder, streams it back and deletes it', async () => {
        const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
        const { key } = await storage.uploadPrivate({ buffer, type: 'png' }, 'payment-proofs')

        expect(key).toMatch(/^payment-proofs\/[a-f0-9-]{36}\.png$/)
        expect(await readFile(join(dir, key))).toEqual(buffer)

        const access = await storage.readPrivate(key)
        expect(access?.kind).toBe('stream')
        if (access?.kind !== 'stream') throw new Error('expected a stream')
        expect(access.contentType).toBe('image/png')
        expect(access.size).toBe(buffer.length)
        expect(await readAll(access.stream)).toEqual(buffer)

        await storage.deletePrivate(key)
        expect(await storage.readPrivate(key)).toBeNull()
    })

    it('refuses keys it did not create (path traversal)', async () => {
        expect(await storage.readPrivate('../.env')).toBeNull()
        expect(await storage.readPrivate('payment-proofs/../../x.png')).toBeNull()
        await expect(storage.deletePrivate('../../package.json')).resolves.toBeUndefined()
    })
})

describe('LocalStorageService media URLs', () => {
    const storage = new LocalStorageService('http://localhost:3000')
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'

    it('recognizes only its own hero uploads, with their kind', () => {
        expect(
            storage.mediaFromUrl(`http://localhost:3000/uploads/hero/${id}.mp4`, 'hero'),
        ).toEqual({ publicId: `hero/${id}.mp4`, kind: 'video' })
        expect(
            storage.mediaFromUrl(`http://localhost:3000/uploads/hero/${id}.avif`, 'hero'),
        ).toEqual({ publicId: `hero/${id}.avif`, kind: 'image' })
        expect(
            storage.mediaFromUrl(`http://localhost:3000/uploads/products/${id}.jpg`, 'hero'),
        ).toBeNull()
        expect(
            storage.mediaFromUrl(`http://localhost:3000/uploads/hero/../../.env`, 'hero'),
        ).toBeNull()
        expect(storage.mediaFromUrl(`https://cdn.example.com/hero/${id}.mp4`, 'hero')).toBeNull()
    })
})
