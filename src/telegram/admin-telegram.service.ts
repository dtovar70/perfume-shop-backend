import {
    BadGatewayException,
    ConflictException,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common'
import { GrammyError } from 'grammy'
import type { AuthUser } from '../common/types/auth-user.js'
import type { TelegramChat } from './entities/telegram-chat.entity.js'
import { LINK_CODE_TTL_MS } from './link-code.js'
import { TelegramBotService, type TelegramBotStatus } from './telegram-bot.service.js'
import { linkedByInactiveUser, TelegramStoreService } from './telegram-store.service.js'

export interface TelegramChatDto {
    id: string
    /** Telegram's chat id, as a string (it may not fit a JS number). */
    chatId: string
    username: string | null
    firstName: string | null
    isActive: boolean
    notifyNewOrders: boolean
    linkedAt: string
    lastSeenAt: string | null
    /** `isActive: false`: that account was deactivated, so the chat gets nothing. */
    linkedBy: { id: string; name: string; isActive: boolean } | null
}

/** `GET /admin/telegram`. */
export interface TelegramOverviewDto {
    bot: TelegramBotStatus
    chats: TelegramChatDto[]
}

/** `POST /admin/telegram/link-codes`: shown once; only its hash is stored. */
export interface TelegramLinkCodeDto {
    code: string
    expiresAt: string
    expiresInSeconds: number
    botUsername: string
    /** `https://t.me/<bot>?start=<code>`: opens the bot with the code filled in. */
    deepLink: string
}

const BOT_OFFLINE =
    'El bot de Telegram no está conectado en este momento. Revisa el estado arriba e intenta de nuevo.'

function toChatDto(chat: TelegramChat): TelegramChatDto {
    return {
        id: chat.id,
        chatId: String(chat.chatId),
        username: chat.username,
        firstName: chat.firstName,
        isActive: chat.isActive,
        notifyNewOrders: chat.notifyNewOrders,
        linkedAt: chat.linkedAt.toISOString(),
        lastSeenAt: chat.lastSeenAt?.toISOString() ?? null,
        linkedBy: chat.linkedBy
            ? {
                  id: chat.linkedBy.id,
                  name: chat.linkedBy.name,
                  isActive: chat.linkedBy.isActive !== false,
              }
            : null,
    }
}

/** The admin "Telegram" page: bot status, link codes and the linked chats. */
@Injectable()
export class AdminTelegramService {
    private readonly logger = new Logger('AdminTelegram')

    constructor(
        private readonly telegram: TelegramBotService,
        private readonly store: TelegramStoreService,
    ) {}

    async overview(): Promise<TelegramOverviewDto> {
        const chats = await this.store.listChats()
        return { bot: this.telegram.status(), chats: chats.map(toChatDto) }
    }

    async createLinkCode(user: AuthUser): Promise<TelegramLinkCodeDto> {
        const username = this.telegram.username
        if (!this.telegram.isConnected || !username) {
            throw new ServiceUnavailableException(BOT_OFFLINE)
        }
        const { code, expiresAt } = await this.store.createLinkCode(user.id)
        return {
            code,
            expiresAt: expiresAt.toISOString(),
            expiresInSeconds: Math.round(LINK_CODE_TTL_MS / 1000),
            botUsername: username,
            deepLink: `https://t.me/${username}?start=${code}`,
        }
    }

    async setNotifyNewOrders(id: string, notify: boolean): Promise<TelegramChatDto> {
        return toChatDto(await this.store.setNotifyNewOrders(id, notify))
    }

    async sendTest(id: string, user: AuthUser): Promise<{ ok: true }> {
        const chat = await this.store.getChat(id)
        if (linkedByInactiveUser(chat)) {
            throw new ConflictException(
                'Este chat lo vinculó una cuenta desactivada, así que no recibe avisos. Vincúlalo de nuevo desde tu cuenta para reactivarlo.',
            )
        }
        const api = this.telegram.api
        if (!api || !this.telegram.isConnected) throw new ServiceUnavailableException(BOT_OFFLINE)
        try {
            await api.sendMessage(
                chat.chatId,
                `👋 ¡Hola! Este es un mensaje de prueba de KaiZen, enviado por ${user.name} desde el panel. Si lo ves, los avisos llegan bien ✅`,
            )
        } catch (error) {
            this.logger.warn(
                `Test message to chat ${chat.chatId} failed: ${this.telegram.describe(error)}`,
            )
            if (error instanceof GrammyError && error.error_code === 403) {
                await this.store.deactivate(chat.chatId)
                throw new BadGatewayException(
                    'Telegram no dejó enviar el mensaje: ese chat bloqueó al bot. Desbloquéalo en Telegram y escríbele /ayuda para reactivarlo.',
                )
            }
            throw new BadGatewayException(
                'Telegram no pudo entregar el mensaje de prueba. Intenta de nuevo en unos minutos.',
            )
        }
        if (!chat.isActive) await this.store.touch(chat, chat)
        return { ok: true }
    }

    async unlink(id: string): Promise<void> {
        const chat = await this.store.getChat(id)
        const api = this.telegram.api
        if (api && this.telegram.isConnected && chat.isActive) {
            // A goodbye is nice but optional: the chat is unlinked anyway.
            await api
                .sendMessage(
                    chat.chatId,
                    '👋 Este chat fue desvinculado desde el panel de KaiZen. Ya no recibirás avisos de pagos.',
                )
                .catch(() => undefined)
        }
        await this.store.unlink(chat.chatId)
        this.logger.log(`Chat ${chat.chatId} unlinked from the admin`)
    }
}
