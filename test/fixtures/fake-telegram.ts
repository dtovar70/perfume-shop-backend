import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FindOperator } from 'typeorm'
import { TelegramChat } from '../../src/telegram/entities/telegram-chat.entity.js'
import { TelegramLinkCode } from '../../src/telegram/entities/telegram-link-code.entity.js'
import { TelegramMessage } from '../../src/telegram/entities/telegram-message.entity.js'
import { USERS, type FakeDb, type Row } from './fake-orders-db.js'

function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
        if (expected instanceof FindOperator) {
            const value = expected.value as unknown
            if (expected.type === 'in') return (value as unknown[]).includes(row[key])
            if (expected.type === 'isNull') return row[key] === null || row[key] === undefined
            if (expected.type === 'moreThan') return (row[key] as Date) > (value as Date)
            throw new Error(`Unsupported operator ${expected.type}`)
        }
        return row[key] === expected
    })
}

type FindOptions = { where?: Row; relations?: Row; order?: Record<string, 'ASC' | 'DESC'> }

/**
 * In-memory repositories for the three Telegram tables, plugged into the orders FakeDb: just the
 * calls TelegramStoreService makes (find, findOne, insert, update, delete with operators).
 */
export class FakeTelegramDb {
    readonly tables = new Map<unknown, Row[]>([
        [TelegramChat, []],
        [TelegramLinkCode, []],
        [TelegramMessage, []],
    ])

    /** Panel users deactivated by the test (their chats are treated as unlinked). */
    readonly inactiveUsers = new Set<string>()

    table(entity: unknown): Row[] {
        const rows = this.tables.get(entity)
        if (!rows) throw new Error('Unknown Telegram entity')
        return rows
    }

    private withRelations(entity: unknown, row: Row, relations: Row = {}): Row {
        if (entity !== TelegramChat || !relations.linkedBy) return { ...row }
        const user = Object.values(USERS).find((candidate) => candidate.id === row.linkedByUserId)
        return {
            ...row,
            linkedBy: user
                ? {
                      id: user.id,
                      name: user.name,
                      email: `${user.id}@example.com`,
                      role: user.role,
                      isActive: !this.inactiveUsers.has(user.id),
                  }
                : null,
        }
    }

    repository(entity: unknown) {
        if (!this.tables.has(entity)) return null
        const rows = () => this.table(entity)
        const find = ({ where, relations, order }: FindOptions = {}) => {
            const found = rows()
                .filter((row) => matches(row, where))
                .map((row) => this.withRelations(entity, row, relations))
            const [key, direction] = Object.entries(order ?? {})[0] ?? []
            if (key) {
                found.sort((a, b) => {
                    const diff = (a[key] as Date).getTime() - (b[key] as Date).getTime()
                    return direction === 'DESC' ? -diff : diff
                })
            }
            return found
        }
        return {
            find: (options?: FindOptions) => Promise.resolve(find(options)),
            findOne: (options: FindOptions) => Promise.resolve(find(options)[0] ?? null),
            insert: (values: Row | Row[]) => {
                for (const value of Array.isArray(values) ? values : [values]) {
                    rows().push({ linkedAt: new Date(), createdAt: new Date(), ...value })
                }
                return Promise.resolve({})
            },
            update: (where: Row, changes: Row) => {
                const hit = rows().filter((row) => matches(row, where))
                for (const row of hit) Object.assign(row, changes)
                return Promise.resolve({ affected: hit.length })
            },
            delete: (where: Row) => {
                const keep = rows().filter((row) => !matches(row, where))
                const affected = rows().length - keep.length
                this.tables.set(entity, keep)
                return Promise.resolve({ affected })
            },
        }
    }

    /** Makes `db.dataSource.getRepository` also serve the Telegram tables. */
    attach(db: FakeDb): void {
        const base = db.dataSource.getRepository
        db.dataSource.getRepository = ((entity: unknown) =>
            this.repository(entity) ?? base(entity)) as typeof base
    }
}

export interface ApiCall {
    method: string
    payload: Row
}

/**
 * A fake Bot API server: records every call and answers like Telegram. Files uploaded with
 * multipart (sendPhoto, sendDocument) are recorded with their fields; the file part becomes
 * `photoBytes` (and its name `fileName`).
 */
export class FakeTelegramServer {
    readonly calls: ApiCall[] = []
    /** Chats that answer 403 (blocked the bot). */
    readonly blockedChats = new Set<string>()
    /** Custom answers per method (e.g. getUpdates for polling tests). */
    readonly overrides = new Map<string, (payload: Row) => Row | Promise<Row>>()
    private nextMessageId = 100
    private server: Server | null = null
    url = ''

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            void this.handle(req).then((body) => {
                res.writeHead(body.ok ? 200 : (body.error_code as number), {
                    'content-type': 'application/json',
                })
                res.end(JSON.stringify(body))
            })
        })
        await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    }

    async stop(): Promise<void> {
        await new Promise((resolve) => this.server?.close(resolve))
    }

    of(method: string): Row[] {
        return this.calls.filter((call) => call.method === method).map((call) => call.payload)
    }

    reset(): void {
        this.calls.length = 0
        this.overrides.clear()
    }

    private async payloadOf(req: IncomingMessage): Promise<Row> {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)
        const type = req.headers['content-type'] ?? ''
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type)
        if (type.startsWith('multipart/form-data') && boundary) {
            return parseMultipart(body, (boundary[1] ?? boundary[2]) as string)
        }
        return body.length ? (JSON.parse(body.toString()) as Row) : {}
    }

    private async handle(req: IncomingMessage): Promise<Row> {
        const method = /\/bot[^/]+\/(\w+)$/.exec(req.url ?? '')?.[1] ?? 'unknown'
        const payload = await this.payloadOf(req)
        this.calls.push({ method, payload })
        const override = this.overrides.get(method)
        if (override) return override(payload)
        const chatId = payload.chat_id === undefined ? undefined : String(payload.chat_id)
        if (chatId && this.blockedChats.has(chatId)) {
            return {
                ok: false,
                error_code: 403,
                description: 'Forbidden: bot was blocked by the user',
            }
        }
        const message = (extra: Row) => ({
            ok: true,
            result: {
                message_id: this.nextMessageId++,
                date: Math.floor(Date.now() / 1000),
                chat: { id: Number(chatId), type: 'private' },
                ...extra,
            },
        })
        switch (method) {
            case 'getMe':
                return {
                    ok: true,
                    result: {
                        id: 42,
                        is_bot: true,
                        first_name: 'Manada Test',
                        username: 'kaizen_test_bot',
                        can_join_groups: false,
                        can_read_all_group_messages: false,
                        supports_inline_queries: false,
                    },
                }
            case 'sendMessage':
                return message({ text: payload.text })
            case 'sendPhoto':
                return message({
                    photo: [{ file_id: 'photo-file-1', file_unique_id: 'u1', width: 1, height: 1 }],
                    caption: payload.caption,
                })
            case 'sendDocument':
                return message({
                    document: { file_id: `doc-file-${this.nextMessageId}`, file_unique_id: 'd' },
                    caption: payload.caption,
                })
            case 'editMessageText':
            case 'editMessageCaption':
            case 'editMessageReplyMarkup':
                return message({})
            default:
                return { ok: true, result: true }
        }
    }
}

/** Minimal multipart/form-data parser (grammY's uploads): text fields and one file. */
function parseMultipart(body: Buffer, boundary: string): Row {
    const payload: Row = {}
    const delimiter = Buffer.from(`--${boundary}`)
    let start = body.indexOf(delimiter)
    while (start !== -1) {
        const next = body.indexOf(delimiter, start + delimiter.length)
        if (next === -1) break
        const part = body.subarray(start + delimiter.length, next)
        const split = part.indexOf('\r\n\r\n')
        if (split !== -1) {
            const headers = part.subarray(0, split).toString()
            // Strip the CRLF that precedes the next delimiter.
            const content = part.subarray(split + 4, part.length - 2)
            const name = /name="([^"]+)"/i.exec(headers)?.[1]
            if (/filename=/i.test(headers)) {
                payload.photoBytes = Buffer.from(content)
                payload.fileName = /filename="?([^"\r\n]*)"?/i.exec(headers)?.[1]
            } else if (name) {
                const value = content.toString()
                payload[name] = /^[[{]/.test(value) ? JSON.parse(value) : value
            }
        }
        start = next
    }
    return payload
}

let updateId = 1

/** A private-chat text message update. */
export function textUpdate(chatId: number, text: string, extra: Row = {}): Row {
    return {
        update_id: updateId++,
        message: {
            message_id: 5000 + updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: 'private', first_name: 'Dueña' },
            from: { id: chatId, is_bot: false, first_name: 'Dueña', username: 'duena' },
            text,
            ...(text.startsWith('/')
                ? {
                      entities: [
                          { type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length },
                      ],
                  }
                : {}),
            ...extra,
        },
    }
}

/** A button tap on the bot's message `messageId`. */
export function callbackUpdate(chatId: number, data: string, messageId = 100): Row {
    return {
        update_id: updateId++,
        callback_query: {
            id: `cb-${updateId}`,
            chat_instance: 'x',
            from: { id: chatId, is_bot: false, first_name: 'Dueña', username: 'duena' },
            message: {
                message_id: messageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: chatId, type: 'private' },
                text: 'x',
            },
            data,
        },
    }
}
