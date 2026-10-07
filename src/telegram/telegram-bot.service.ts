import {
    Injectable,
    Logger,
    type OnApplicationBootstrap,
    type OnApplicationShutdown,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Bot, GrammyError, HttpError, type Api, type Context } from 'grammy'
import type { BotCommand, Update, UserFromGetMe } from 'grammy/types'
import type { Env } from '../config/env.schema.js'
import { telegramSettings, type TelegramMode, type TelegramSettings } from './telegram.config.js'

/** Updates the bot asks Telegram for. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const

export const BOT_COMMANDS: BotCommand[] = [
    { command: 'pendientes', description: 'Pagos por verificar' },
    { command: 'pedido', description: 'Resumen de un pedido: /pedido KZ-000012' },
    { command: 'micuenta', description: 'Tu cuenta del panel vinculada a este chat' },
    { command: 'ayuda', description: 'Qué puedo hacer' },
    { command: 'salir', description: 'Desvincular este chat' },
]

/** Backoff between connection attempts (tests shorten it). */
export const TELEGRAM_RETRY = {
    firstMs: 5_000,
    maxMs: 5 * 60_000,
    /** A rejected token will not fix itself; check again rarely. */
    unauthorizedMs: 30 * 60_000,
}
const STOP_TIMEOUT_MS = 5_000
/**
 * Every Bot API call is aborted after this (grammY's default is 500 s), so a stalled Telegram
 * never holds an approval request or a notification for minutes.
 */
const API_TIMEOUT_SECONDS = 15
/** getUpdates long-poll: must stay under API_TIMEOUT_SECONDS or every poll would be aborted. */
const LONG_POLL_SECONDS = 10

export interface TelegramBotStatus {
    enabled: boolean
    mode: TelegramMode
    connected: boolean
    username: string | null
    name: string | null
    /** Spanish explanation when not connected. */
    error: string | null
}

/**
 * Describes a Telegram/network error without ever including the token (grammY's HttpError
 * messages can contain the request URL, which has the token in its path).
 */
export function describeTelegramError(error: unknown, token?: string): string {
    let text: string
    if (error instanceof GrammyError) text = `${error.error_code} ${error.description}`
    else if (error instanceof HttpError) text = `network error (${String(error.error)})`
    else if (error instanceof Error) text = error.message
    else text = String(error)
    return token ? text.split(token).join('<token>') : text
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve()
        const timer = setTimeout(done, ms)
        function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
        }
        signal.addEventListener('abort', done, { once: true })
    })
}

/**
 * Owns the grammY bot: created at construction (handlers register in their `onModuleInit`),
 * connected after the app started, without blocking the boot. Polling survives network errors
 * and 409 conflicts (another poller, e.g. the previous `nest start --watch` process still
 * shutting down) by retrying with backoff; it stops on shutdown (`enableShutdownHooks`) so the
 * next process can take over. In webhook mode it registers the webhook and the controller feeds
 * the updates in.
 */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger('TelegramBot')
    readonly settings: TelegramSettings
    /** Null when the bot is disabled. */
    readonly bot: Bot | null
    private connected = false
    private lastError: string | null = null
    private readonly shutdown = new AbortController()
    private runner: Promise<void> | null = null

    constructor(config: ConfigService<Env, true>) {
        this.settings = telegramSettings(config)
        this.bot = this.settings.enabled
            ? new Bot(this.settings.token, {
                  client: {
                      timeoutSeconds: API_TIMEOUT_SECONDS,
                      ...(this.settings.apiRoot && { apiRoot: this.settings.apiRoot }),
                  },
              })
            : null
        this.bot?.catch((error) => {
            this.logger.error(
                `Error handling update ${error.ctx.update.update_id}: ${this.describe(error.error)}`,
            )
        })
    }

    get enabled(): boolean {
        return this.bot !== null
    }

    /** The Bot API client; null when disabled. */
    get api(): Api | null {
        return this.bot?.api ?? null
    }

    get username(): string | null {
        return this.bot?.isInited() ? this.bot.botInfo.username : null
    }

    /** Ready to send and receive (getMe succeeded, and polling or the webhook is set up). */
    get isConnected(): boolean {
        return this.connected
    }

    status(): TelegramBotStatus {
        const settings = this.settings
        const info: UserFromGetMe | null = this.bot?.isInited() ? this.bot.botInfo : null
        return {
            enabled: settings.enabled,
            mode: settings.mode,
            connected: this.connected,
            username: info?.username ?? null,
            name: info?.first_name ?? null,
            error: settings.enabled
                ? this.connected
                    ? null
                    : (this.lastError ?? 'Conectando con Telegram…')
                : settings.message,
        }
    }

    describe(error: unknown): string {
        return describeTelegramError(error, this.settings.enabled ? this.settings.token : undefined)
    }

    onApplicationBootstrap(): void {
        if (!this.bot) {
            const reason = this.settings.enabled ? '' : this.settings.reason
            this.logger.log(`Telegram bot disabled: ${reason}`)
            return
        }
        this.logger.log(`Telegram bot starting (${this.settings.mode} mode)`)
        // Never awaited: the API must not wait for (or fail because of) Telegram.
        this.runner = this.run(this.bot).catch((error: unknown) => {
            this.logger.error(`Telegram bot stopped unexpectedly: ${this.describe(error)}`)
        })
    }

    async onApplicationShutdown(): Promise<void> {
        if (!this.bot) return
        this.shutdown.abort()
        if (this.bot.isRunning()) {
            await Promise.race([
                this.bot.stop().catch((error: unknown) => {
                    this.logger.warn(
                        `Telegram polling did not stop cleanly: ${this.describe(error)}`,
                    )
                }),
                new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref()),
            ])
            this.logger.log('Telegram polling stopped')
        }
        this.connected = false
        await Promise.race([
            this.runner,
            new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref()),
        ])
    }

    /** Feeds one webhook update to the handlers. */
    async handleWebhookUpdate(update: Update): Promise<void> {
        if (!this.bot?.isInited()) throw new Error('Telegram bot not ready')
        await this.bot.handleUpdate(update)
    }

    /** Connects (with retries) and, in polling mode, polls until shutdown. */
    private async run(bot: Bot<Context>): Promise<void> {
        const { signal } = this.shutdown
        let delay = TELEGRAM_RETRY.firstMs
        while (!signal.aborted) {
            try {
                // getMe ourselves (grammY's init retries silently forever): failures get logged.
                if (!bot.isInited()) {
                    bot.botInfo = await bot.api.getMe(signal as Parameters<Api['getMe']>[0])
                }
                if (signal.aborted) return
                await this.setCommands(bot)
                if (this.settings.enabled && this.settings.mode === 'webhook') {
                    await bot.api.setWebhook(this.settings.webhookUrl, {
                        secret_token: this.settings.webhookSecret ?? undefined,
                        allowed_updates: [...ALLOWED_UPDATES],
                    })
                    this.markConnected(bot, `webhook set to ${this.settings.webhookUrl}`)
                    return
                }
                await bot.start({
                    allowed_updates: [...ALLOWED_UPDATES],
                    timeout: LONG_POLL_SECONDS,
                    onStart: () => {
                        delay = TELEGRAM_RETRY.firstMs
                        this.markConnected(bot, 'polling started')
                    },
                })
                // bot.start() resolves when polling stops: on shutdown, or bot.stop() elsewhere.
                this.connected = false
                if (signal.aborted) return
                this.logger.warn('Telegram polling ended; restarting')
            } catch (error) {
                this.connected = false
                if (signal.aborted) return
                const wait = this.onRunError(error, delay)
                await sleep(wait, signal)
                delay = Math.min(delay * 2, TELEGRAM_RETRY.maxMs)
            }
        }
    }

    /** Logs the failure and returns how long to wait before retrying. */
    private onRunError(error: unknown, delay: number): number {
        if (error instanceof GrammyError && error.error_code === 409) {
            this.lastError =
                'Otra instancia del bot está conectada (por ejemplo, un reinicio en curso). Reintentando…'
            this.logger.warn(
                `Telegram answered 409 Conflict: another process is polling this bot (usually the previous watch reload still shutting down, or another environment with the same token). Retrying in ${Math.round(delay / 1000)} s.`,
            )
            return delay
        }
        if (error instanceof GrammyError && error.error_code === 401) {
            this.lastError = 'Telegram rechazó el token del bot. Revisa TELEGRAM_BOT_TOKEN.'
            this.logger.error(
                'Telegram rejected the bot token (401 Unauthorized). Check TELEGRAM_BOT_TOKEN.',
            )
            return TELEGRAM_RETRY.unauthorizedMs
        }
        this.lastError = 'No pudimos conectar con Telegram. Reintentando…'
        this.logger.warn(
            `Telegram connection failed: ${this.describe(error)}. Retrying in ${Math.round(delay / 1000)} s.`,
        )
        return delay
    }

    private markConnected(bot: Bot, detail: string): void {
        this.connected = true
        this.lastError = null
        this.logger.log(`Telegram bot @${bot.botInfo.username} connected (${detail})`)
    }

    private async setCommands(bot: Bot): Promise<void> {
        try {
            await bot.api.setMyCommands(BOT_COMMANDS)
        } catch (error) {
            // Only the command menu is missing; the bot works anyway.
            this.logger.warn(`setMyCommands failed: ${this.describe(error)}`)
        }
    }
}
