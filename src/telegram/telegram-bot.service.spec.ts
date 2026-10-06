import type { ConfigService } from '@nestjs/config'
import { FakeTelegramServer } from '../../test/fixtures/fake-telegram.js'
import { validateEnv, type Env } from '../config/env.schema.js'
import {
    describeTelegramError,
    TELEGRAM_RETRY,
    TelegramBotService,
} from './telegram-bot.service.js'
import { GrammyError } from 'grammy'

const TOKEN = '123456:SECRET-TOKEN'

function configOf(values: Record<string, string>): ConfigService<Env, true> {
    const env = validateEnv({
        DATABASE_URL: 'postgresql://x:y@localhost:5440/db',
        JWT_SECRET: 'x'.repeat(32),
        ...values,
    })
    return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>
}

async function eventually(check: () => void, timeoutMs = 3000): Promise<void> {
    const started = Date.now()
    for (;;) {
        try {
            check()
            return
        } catch (error) {
            if (Date.now() - started > timeoutMs) throw error
            await new Promise((resolve) => setTimeout(resolve, 20))
        }
    }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('TelegramBotService', () => {
    const server = new FakeTelegramServer()
    const retry = { ...TELEGRAM_RETRY }

    beforeAll(async () => {
        await server.start()
        TELEGRAM_RETRY.firstMs = 30
        TELEGRAM_RETRY.maxMs = 60
    })

    afterAll(async () => {
        Object.assign(TELEGRAM_RETRY, retry)
        await server.stop()
    })

    beforeEach(() => server.reset())

    it('stays off without a token, explaining why', () => {
        const service = new TelegramBotService(configOf({ NODE_ENV: 'development' }))
        expect(service.enabled).toBe(false)
        expect(() => service.onApplicationBootstrap()).not.toThrow()
        expect(service.status()).toMatchObject({
            enabled: false,
            connected: false,
            error: expect.stringContaining('TELEGRAM_BOT_TOKEN'),
        })
    })

    it('stays off under NODE_ENV=test unless forced, and when TELEGRAM_ENABLED=false', () => {
        expect(
            new TelegramBotService(configOf({ NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: TOKEN }))
                .enabled,
        ).toBe(false)
        expect(
            new TelegramBotService(
                configOf({
                    NODE_ENV: 'development',
                    TELEGRAM_BOT_TOKEN: TOKEN,
                    TELEGRAM_ENABLED: 'false',
                }),
            ).enabled,
        ).toBe(false)
    })

    it('refuses webhook mode without a secret', () => {
        // In production the env validation already refuses to start; this guard covers the rest.
        const service = new TelegramBotService(
            configOf({
                NODE_ENV: 'development',
                TELEGRAM_MODE: 'webhook',
                TELEGRAM_BOT_TOKEN: TOKEN,
            }),
        )
        expect(service.enabled).toBe(false)
        expect(service.status()).toMatchObject({
            mode: 'webhook',
            error: expect.stringContaining('TELEGRAM_WEBHOOK_SECRET'),
        })
    })

    it('polls, survives a 409 conflict and stops cleanly on shutdown', async () => {
        let getUpdatesCalls = 0
        server.overrides.set('getUpdates', async () => {
            getUpdatesCalls++
            await pause(20)
            if (getUpdatesCalls === 2) {
                return {
                    ok: false,
                    error_code: 409,
                    description: 'Conflict: terminated by other getUpdates request',
                }
            }
            return { ok: true, result: [] }
        })
        const service = new TelegramBotService(
            configOf({
                NODE_ENV: 'development',
                TELEGRAM_BOT_TOKEN: TOKEN,
                TELEGRAM_API_ROOT: server.url,
            }),
        )
        const warn = vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined)
        service.onApplicationBootstrap()
        await eventually(() => expect(server.of('deleteWebhook').length).toBeGreaterThanOrEqual(2))
        await eventually(() => expect(service.status().connected).toBe(true))
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('409 Conflict'))
        expect(service.status()).toMatchObject({ username: 'kaizen_test_bot', mode: 'polling' })
        expect(server.of('setMyCommands')).not.toHaveLength(0)

        await service.onApplicationShutdown()
        expect(service.bot?.isRunning()).toBe(false)
        expect(service.status().connected).toBe(false)
        const calls = getUpdatesCalls
        await pause(100)
        expect(getUpdatesCalls).toBe(calls)
    })

    it('retries when Telegram cannot be reached, then connects', async () => {
        let getMeCalls = 0
        server.overrides.set('getMe', () => {
            getMeCalls++
            return getMeCalls < 3
                ? { ok: false, error_code: 502, description: 'Bad Gateway' }
                : {
                      ok: true,
                      result: {
                          id: 42,
                          is_bot: true,
                          first_name: 'Bot',
                          username: 'kaizen_test_bot',
                      },
                  }
        })
        server.overrides.set('getUpdates', async () => {
            await pause(20)
            return { ok: true, result: [] }
        })
        const service = new TelegramBotService(
            configOf({
                NODE_ENV: 'development',
                TELEGRAM_BOT_TOKEN: TOKEN,
                TELEGRAM_API_ROOT: server.url,
            }),
        )
        const warn = vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined)
        service.onApplicationBootstrap()
        expect(service.status().connected).toBe(false)
        await eventually(() => expect(service.status().connected).toBe(true))
        expect(getMeCalls).toBe(3)
        expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET-TOKEN')
        await service.onApplicationShutdown()
    })

    it('never includes the token in error descriptions', () => {
        const error = new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`)
        expect(describeTelegramError(error, TOKEN)).toBe(
            'request to https://api.telegram.org/bot<token>/getMe failed',
        )
        const grammy = new GrammyError(
            'x',
            { ok: false, error_code: 403, description: 'Forbidden' },
            'sendMessage',
            {},
        )
        expect(describeTelegramError(grammy, TOKEN)).toBe('403 Forbidden')
    })
})
