import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import type {
    PasswordResetChannel,
    PasswordResetRecipient,
} from '../auth/password-reset/password-reset.channel.js'
import { TelegramChat } from './entities/telegram-chat.entity.js'
import { TelegramBotService } from './telegram-bot.service.js'
import { TelegramPaymentsService } from './telegram-payments.service.js'

export function passwordResetCodeMessage(code: string, ttlMinutes: number): string {
    return `🔐 Código para restablecer tu contraseña de KaiZen: <b>${code}</b>\nVence en ${ttlMinutes} minutos. Si no fuiste tú, ignora este mensaje y avísale a un administrador.`
}

export const PASSWORD_CHANGED_MESSAGE =
    '✅ Tu contraseña se cambió. Si no fuiste tú, contacta a un administrador.'

/**
 * Password reset codes through the bot: sent to every active chat the user linked
 * (`telegram_chats.linked_by_user_id`). Chats linked by someone else never get them.
 */
@Injectable()
export class TelegramPasswordResetChannel implements PasswordResetChannel {
    readonly id = 'telegram' as const
    private readonly logger = new Logger('TelegramPasswordReset')

    constructor(
        @InjectRepository(TelegramChat) private readonly chats: Repository<TelegramChat>,
        private readonly telegram: TelegramBotService,
        private readonly payments: TelegramPaymentsService,
    ) {}

    private userChats(userId: string): Promise<TelegramChat[]> {
        return this.chats.find({
            where: { linkedByUserId: userId, isActive: true },
            order: { linkedAt: 'ASC' },
        })
    }

    async canReach(user: PasswordResetRecipient): Promise<boolean> {
        const chats = await this.userChats(user.id)
        if (chats.length && !this.telegram.api) {
            this.logger.warn(
                `User ${user.id} has a linked chat but the Telegram bot is disabled; no reset code sent`,
            )
            return false
        }
        return chats.length > 0
    }

    async sendCode(user: PasswordResetRecipient, code: string, ttlMinutes: number) {
        return this.send(user, passwordResetCodeMessage(code, ttlMinutes), true)
    }

    async sendPasswordChanged(user: PasswordResetRecipient): Promise<void> {
        await this.send(user, PASSWORD_CHANGED_MESSAGE, false)
    }

    private async send(
        user: PasswordResetRecipient,
        text: string,
        secret: boolean,
    ): Promise<number> {
        const api = this.telegram.api
        if (!api) return 0
        let delivered = 0
        for (const chat of await this.userChats(user.id)) {
            const sent = await this.payments.deliver(chat.chatId, 'sendMessage', () =>
                api.sendMessage(chat.chatId, text, {
                    parse_mode: 'HTML',
                    // The code should not be forwarded or saved from the chat.
                    ...(secret ? { protect_content: true } : {}),
                }),
            )
            if (sent) delivered++
        }
        return delivered
    }
}
