import { Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { In, IsNull, MoreThan, Repository } from 'typeorm'
import type { Env } from '../config/env.schema.js'
import { newId } from '../database/id.js'
import { TelegramChat } from './entities/telegram-chat.entity.js'
import { TelegramLinkCode } from './entities/telegram-link-code.entity.js'
import { TelegramMessage, type TelegramMessageKind } from './entities/telegram-message.entity.js'
import { generateLinkCode, hashLinkCode, LINK_CODE_PATTERN, LINK_CODE_TTL_MS } from './link-code.js'

export const TELEGRAM_CHAT_NOT_FOUND = 'No encontramos ese chat de Telegram.'

/** Who wrote to the bot, as Telegram describes them. */
export interface TelegramSender {
    chatId: string
    username: string | null
    firstName: string | null
}

export interface NewTelegramMessage {
    chatId: string
    messageId: number
    orderId: string
    paymentId: string | null
    kind: TelegramMessageKind
}

/**
 * The admin panel account that linked the chat was deactivated: the chat is treated as
 * unlinked (no order data, no actions) until an active admin links it again.
 */
export function linkedByInactiveUser(chat: TelegramChat): boolean {
    return chat.linkedBy?.isActive === false
}

/** Telegram names are free text of any length; the columns are varchar(100). */
function clip(value: string | null | undefined): string | null {
    const trimmed = value?.trim()
    return trimmed ? [...trimmed].slice(0, 100).join('') : null
}

/** Linked chats, one-time link codes and the messages the bot sent. */
@Injectable()
export class TelegramStoreService {
    private readonly secret: string

    constructor(
        @InjectRepository(TelegramChat) private readonly chats: Repository<TelegramChat>,
        @InjectRepository(TelegramLinkCode) private readonly codes: Repository<TelegramLinkCode>,
        @InjectRepository(TelegramMessage) private readonly messages: Repository<TelegramMessage>,
        config: ConfigService<Env, true>,
    ) {
        this.secret = config.get('JWT_SECRET', { infer: true })
    }

    // Chats

    listChats(): Promise<TelegramChat[]> {
        return this.chats.find({ relations: { linkedBy: true }, order: { linkedAt: 'ASC' } })
    }

    async getChat(id: string): Promise<TelegramChat> {
        const chat = await this.chats.findOne({ where: { id }, relations: { linkedBy: true } })
        if (!chat) throw new NotFoundException(TELEGRAM_CHAT_NOT_FOUND)
        return chat
    }

    findByChatId(chatId: string): Promise<TelegramChat | null> {
        return this.chats.findOne({ where: { chatId }, relations: { linkedBy: true } })
    }

    /** Chats that get notifications (`newOrders`: only those that asked for new orders). */
    activeChats(options: { newOrders?: boolean } = {}): Promise<TelegramChat[]> {
        return this.chats.find({
            where: { isActive: true, ...(options.newOrders ? { notifyNewOrders: true } : {}) },
            order: { linkedAt: 'ASC' },
        })
    }

    /** A linked chat wrote: refresh its names and last-seen time, and reactivate it. */
    async touch(chat: TelegramChat, sender: TelegramSender): Promise<void> {
        const changes: Partial<TelegramChat> = {
            lastSeenAt: new Date(),
            isActive: true,
            username: clip(sender.username),
            firstName: clip(sender.firstName),
        }
        await this.chats.update({ id: chat.id }, changes)
        Object.assign(chat, changes)
    }

    async setNotifyNewOrders(id: string, notify: boolean): Promise<TelegramChat> {
        await this.getChat(id)
        await this.chats.update({ id }, { notifyNewOrders: notify })
        return this.getChat(id)
    }

    /** Telegram said 403 (the user blocked the bot or deleted the chat). */
    async deactivate(chatId: string): Promise<void> {
        await this.chats.update({ chatId }, { isActive: false })
    }

    /** Unlinks a chat; its tracked messages go with it (FK cascade). */
    async unlink(chatId: string): Promise<void> {
        await this.messages.delete({ chatId })
        await this.chats.delete({ chatId })
    }

    // Link codes

    /** A new one-time code; only its HMAC is stored. Never collides with a live code. */
    async createLinkCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
        const now = new Date()
        for (let attempt = 0; ; attempt++) {
            const code = generateLinkCode()
            const codeHash = hashLinkCode(code, this.secret)
            const live = await this.codes.findOne({
                where: { codeHash, usedAt: IsNull(), expiresAt: MoreThan(now) },
            })
            if (live && attempt < 20) continue
            const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS)
            await this.codes.insert({
                id: newId(),
                codeHash,
                createdByUserId: userId,
                expiresAt,
                usedAt: null,
                usedByChatId: null,
                createdAt: now,
            })
            return { code, expiresAt }
        }
    }

    /**
     * Links the chat when `code` is a live code (unused, not expired). The code is burned with a
     * conditional update, so two chats racing with the same code cannot both win. Returns the
     * linked chat, or null for a wrong, used or expired code.
     */
    async consumeLinkCode(code: string, sender: TelegramSender): Promise<TelegramChat | null> {
        if (!LINK_CODE_PATTERN.test(code)) return null
        const now = new Date()
        const found = await this.codes.findOne({
            where: {
                codeHash: hashLinkCode(code, this.secret),
                usedAt: IsNull(),
                expiresAt: MoreThan(now),
            },
        })
        if (!found) return null
        const burned = await this.codes.update(
            { id: found.id, usedAt: IsNull() },
            { usedAt: now, usedByChatId: sender.chatId },
        )
        if (burned.affected === 0) return null

        const existing = await this.chats.findOne({ where: { chatId: sender.chatId } })
        const values = {
            username: clip(sender.username),
            firstName: clip(sender.firstName),
            linkedByUserId: found.createdByUserId,
            isActive: true,
            linkedAt: now,
            lastSeenAt: now,
        }
        if (existing) {
            await this.chats.update({ id: existing.id }, values)
        } else {
            await this.chats.insert({
                id: newId(),
                chatId: sender.chatId,
                notifyNewOrders: false,
                ...values,
            })
        }
        return this.findByChatId(sender.chatId)
    }

    // Messages

    async recordMessages(entries: readonly NewTelegramMessage[]): Promise<void> {
        if (!entries.length) return
        await this.messages.insert(
            entries.map((entry) => ({
                id: newId(),
                ...entry,
                resolution: null,
                createdAt: new Date(),
            })),
        )
    }

    /** The detail messages (text or captioned photo) of a payment, in every chat. */
    paymentMessages(paymentId: string): Promise<TelegramMessage[]> {
        return this.messages.find({
            where: { paymentId, kind: In(['payment', 'payment_caption']) },
        })
    }

    /** The "Nuevo pedido" notices of an order, in every chat. */
    newOrderMessages(orderId: string): Promise<TelegramMessage[]> {
        return this.messages.find({ where: { orderId, kind: 'new_order' } })
    }

    /** Every payment detail message of an order. */
    orderPaymentMessages(orderId: string): Promise<TelegramMessage[]> {
        return this.messages.find({
            where: { orderId, kind: In(['payment', 'payment_caption']) },
        })
    }

    promptMessages(paymentId: string, chatId?: string): Promise<TelegramMessage[]> {
        return this.messages.find({
            where: { paymentId, kind: 'prompt', ...(chatId ? { chatId } : {}) },
        })
    }

    findMessage(chatId: string, messageId: number): Promise<TelegramMessage | null> {
        return this.messages.findOne({ where: { chatId, messageId } })
    }

    /** The first outcome wins: a later event never rewrites who handled the payment. */
    async setResolution(paymentId: string, resolution: string): Promise<void> {
        await this.messages.update(
            { paymentId, kind: In(['payment', 'payment_caption']), resolution: IsNull() },
            { resolution },
        )
    }

    async deleteMessages(ids: readonly string[]): Promise<void> {
        if (ids.length) await this.messages.delete({ id: In([...ids]) })
    }
}
