import { envSchema, validateEnv } from './env.schema.js'

const BASE = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5440/db',
    JWT_SECRET: 'x'.repeat(32),
}

describe('envSchema', () => {
    it('defaults the admin session to 30 idle minutes and a 30-second prompt', () => {
        const env = validateEnv(BASE)
        expect(env.SESSION_IDLE_MINUTES).toBe(30)
        expect(env.SESSION_PROMPT_SECONDS).toBe(30)
    })

    it('coerces the session timings from strings', () => {
        const env = validateEnv({
            ...BASE,
            SESSION_IDLE_MINUTES: '1',
            SESSION_PROMPT_SECONDS: '10',
        })
        expect(env.SESSION_IDLE_MINUTES).toBe(1)
        expect(env.SESSION_PROMPT_SECONDS).toBe(10)
    })

    it('ignores a leftover JWT_EXPIRES_IN from an older .env', () => {
        const env = validateEnv({ ...BASE, JWT_EXPIRES_IN: '7d' })
        expect(env).not.toHaveProperty('JWT_EXPIRES_IN')
    })

    it('rejects invalid session timings', () => {
        expect(envSchema.safeParse({ ...BASE, SESSION_IDLE_MINUTES: '0' }).success).toBe(false)
        expect(envSchema.safeParse({ ...BASE, SESSION_PROMPT_SECONDS: 'abc' }).success).toBe(false)
        expect(() => validateEnv({ ...BASE, SESSION_PROMPT_SECONDS: '1' })).toThrow(
            /SESSION_PROMPT_SECONDS/,
        )
    })
})

describe('envSchema (orders and exchange rate)', () => {
    it('defaults the payment window, expiry, rate age and sync interval', () => {
        const env = validateEnv(BASE)
        expect(env.ORDER_PAYMENT_WINDOW_HOURS).toBe(24)
        expect(env.ORDER_EXPIRY_INTERVAL_MINUTES).toBe(10)
        expect(env.EXCHANGE_RATE_MAX_AGE_HOURS).toBe(24)
        expect(env.EXCHANGE_RATE_SYNC_INTERVAL_MINUTES).toBe(120)
        expect(env.SCHEDULED_JOBS_ENABLED).toBeUndefined()
    })

    it('accepts fractions (short windows for testing) and booleans', () => {
        const env = validateEnv({
            ...BASE,
            ORDER_PAYMENT_WINDOW_HOURS: '0.01',
            SCHEDULED_JOBS_ENABLED: 'false',
        })
        expect(env.ORDER_PAYMENT_WINDOW_HOURS).toBe(0.01)
        expect(env.SCHEDULED_JOBS_ENABLED).toBe(false)
        expect(envSchema.safeParse({ ...BASE, ORDER_PAYMENT_WINDOW_HOURS: '0' }).success).toBe(
            false,
        )
        expect(envSchema.safeParse({ ...BASE, SCHEDULED_JOBS_ENABLED: 'maybe' }).success).toBe(
            false,
        )
    })
})

describe('envSchema (public site URL)', () => {
    it('defaults to the Vite dev server and drops trailing slashes', () => {
        expect(validateEnv(BASE).PUBLIC_SITE_URL).toBe('http://localhost:5173')
        expect(
            validateEnv({ ...BASE, PUBLIC_SITE_URL: 'https://kaizen.com/' }).PUBLIC_SITE_URL,
        ).toBe('https://kaizen.com')
        expect(envSchema.safeParse({ ...BASE, PUBLIC_SITE_URL: 'not a url' }).success).toBe(false)
    })
})

describe('envSchema (Telegram)', () => {
    it('leaves every Telegram variable optional', () => {
        const env = validateEnv(BASE)
        expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
        expect(env.TELEGRAM_ENABLED).toBeUndefined()
        expect(env.TELEGRAM_MODE).toBeUndefined()
        expect(env.TELEGRAM_WEBHOOK_SECRET).toBeUndefined()
    })

    it('parses the mode, the switch and the webhook secret', () => {
        const env = validateEnv({
            ...BASE,
            TELEGRAM_BOT_TOKEN: ' 123:abc ',
            TELEGRAM_ENABLED: 'false',
            TELEGRAM_MODE: 'webhook',
            TELEGRAM_WEBHOOK_SECRET: 'abc_DEF-123',
            TELEGRAM_API_ROOT: 'http://127.0.0.1:8081/',
        })
        expect(env).toMatchObject({
            TELEGRAM_BOT_TOKEN: '123:abc',
            TELEGRAM_ENABLED: false,
            TELEGRAM_MODE: 'webhook',
            TELEGRAM_WEBHOOK_SECRET: 'abc_DEF-123',
            TELEGRAM_API_ROOT: 'http://127.0.0.1:8081',
        })
    })

    it('rejects an unknown mode and a secret Telegram would refuse', () => {
        expect(envSchema.safeParse({ ...BASE, TELEGRAM_MODE: 'push' }).success).toBe(false)
        expect(
            envSchema.safeParse({ ...BASE, TELEGRAM_WEBHOOK_SECRET: 'has spaces!' }).success,
        ).toBe(false)
    })
})

describe('envSchema (mail)', () => {
    it('defaults to the log driver with nothing else required', () => {
        const env = validateEnv(BASE)
        expect(env.MAIL_DRIVER).toBe('log')
        expect(env.MAIL_FROM).toBeUndefined()
        expect(env.SMTP_PORT).toBeUndefined()
    })

    it('accepts Mailpit settings (smtp without login)', () => {
        const env = validateEnv({
            ...BASE,
            MAIL_DRIVER: 'smtp',
            MAIL_FROM: 'KaiZen Perfumería <pedidos@kaizen.test>',
            SMTP_HOST: 'localhost',
            SMTP_PORT: '1025',
            SMTP_USER: '',
            SMTP_PASS: '',
        })
        expect(env).toMatchObject({ MAIL_DRIVER: 'smtp', SMTP_HOST: 'localhost', SMTP_PORT: 1025 })
        expect(env.SMTP_USER).toBeUndefined()
    })

    it('requires the right variables per driver', () => {
        expect(() => validateEnv({ ...BASE, MAIL_DRIVER: 'smtp' })).toThrow(
            /MAIL_FROM[\s\S]*SMTP_HOST[\s\S]*SMTP_PORT/,
        )
        expect(() =>
            validateEnv({
                ...BASE,
                MAIL_DRIVER: 'smtp',
                MAIL_FROM: 'pedidos@example.com',
                SMTP_HOST: 'smtp.example.com',
                SMTP_PORT: '587',
                SMTP_USER: 'only-user',
            }),
        ).toThrow(/SMTP_PASS/)
        expect(() =>
            validateEnv({ ...BASE, MAIL_DRIVER: 'resend', MAIL_FROM: 'pedidos@example.com' }),
        ).toThrow(/RESEND_API_KEY/)
        expect(
            validateEnv({
                ...BASE,
                MAIL_DRIVER: 'resend',
                MAIL_FROM: 'pedidos@example.com',
                MAIL_REPLY_TO: 'Tienda <hola@example.com>',
                RESEND_API_KEY: 're_123',
            }).MAIL_DRIVER,
        ).toBe('resend')
    })

    it('rejects an unknown driver, a malformed sender and a bad port', () => {
        expect(envSchema.safeParse({ ...BASE, MAIL_DRIVER: 'sendgrid' }).success).toBe(false)
        expect(envSchema.safeParse({ ...BASE, MAIL_FROM: 'not an address' }).success).toBe(false)
        expect(envSchema.safeParse({ ...BASE, SMTP_PORT: '70000' }).success).toBe(false)
        expect(envSchema.safeParse({ ...BASE, SMTP_PORT: 'abc' }).success).toBe(false)
    })
})

describe('envSchema (trust proxy)', () => {
    it('parses hop counts, false and address lists', () => {
        expect(validateEnv(BASE).TRUST_PROXY).toBeUndefined()
        expect(validateEnv({ ...BASE, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1)
        expect(validateEnv({ ...BASE, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false)
        expect(validateEnv({ ...BASE, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false)
        expect(validateEnv({ ...BASE, TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback')
        expect(validateEnv({ ...BASE, TRUST_PROXY: 'loopback,  172.16.0.0/12' }).TRUST_PROXY).toBe(
            'loopback, 172.16.0.0/12',
        )
    })

    it('refuses "true" (any client could spoof its IP) and garbage', () => {
        expect(() => validateEnv({ ...BASE, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/)
        expect(envSchema.safeParse({ ...BASE, TRUST_PROXY: 'caddy proxy' }).success).toBe(false)
    })
})

describe('envSchema (production)', () => {
    const PRODUCTION = {
        ...BASE,
        NODE_ENV: 'production',
        PUBLIC_API_URL: 'https://api.kaizen.com',
        PUBLIC_SITE_URL: 'https://kaizen.com',
        CORS_ORIGIN: 'https://kaizen.com,https://www.kaizen.com',
        CLOUDINARY_CLOUD_NAME: 'kaizen',
        CLOUDINARY_API_KEY: '123',
        CLOUDINARY_API_SECRET: 'secret',
        MAIL_DRIVER: 'resend',
        MAIL_FROM: 'KaiZen Perfumería <pedidos@kaizen.com>',
        RESEND_API_KEY: 're_123',
    }

    it('accepts a complete production configuration', () => {
        const env = validateEnv(PRODUCTION)
        expect(env.NODE_ENV).toBe('production')
        expect(env.CORS_ORIGIN).toEqual(['https://kaizen.com', 'https://www.kaizen.com'])
    })

    it('refuses the development defaults, listing everything that is missing', () => {
        let message = ''
        try {
            validateEnv({ ...BASE, NODE_ENV: 'production' })
        } catch (error) {
            message = (error as Error).message
        }
        for (const key of [
            'PUBLIC_API_URL',
            'PUBLIC_SITE_URL',
            'CORS_ORIGIN',
            'CLOUDINARY_CLOUD_NAME',
            'CLOUDINARY_API_KEY',
            'CLOUDINARY_API_SECRET',
            'MAIL_DRIVER',
        ]) {
            expect(message).toContain(`${key}: [production]`)
        }
    })

    it('requires https and a public host for the public URLs', () => {
        expect(() =>
            validateEnv({ ...PRODUCTION, PUBLIC_API_URL: 'http://api.kaizen.com' }),
        ).toThrow(/PUBLIC_API_URL: \[production\]/)
        expect(() =>
            validateEnv({ ...PRODUCTION, PUBLIC_SITE_URL: 'https://127.0.0.1:5173' }),
        ).toThrow(/PUBLIC_SITE_URL: \[production\]/)
    })

    it('refuses localhost among the CORS origins', () => {
        expect(() =>
            validateEnv({
                ...PRODUCTION,
                CORS_ORIGIN: 'https://kaizen.com,http://localhost:5173',
            }),
        ).toThrow(/CORS_ORIGIN: \[production\].*http:\/\/localhost:5173/)
    })

    it('requires every Cloudinary variable', () => {
        expect(() => validateEnv({ ...PRODUCTION, CLOUDINARY_API_SECRET: '' })).toThrow(
            /CLOUDINARY_API_SECRET: \[production\]/,
        )
    })

    it('accepts smtp with a real server but not a local one', () => {
        const smtp = {
            ...PRODUCTION,
            MAIL_DRIVER: 'smtp',
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '587',
            SMTP_USER: 'user',
            SMTP_PASS: 'pass',
        }
        expect(validateEnv(smtp).MAIL_DRIVER).toBe('smtp')
        expect(() => validateEnv({ ...smtp, SMTP_HOST: 'localhost' })).toThrow(
            /SMTP_HOST: \[production\]/,
        )
    })

    it('requires the webhook secret when the bot runs in webhook mode', () => {
        expect(() => validateEnv({ ...PRODUCTION, TELEGRAM_BOT_TOKEN: '123:abc' })).toThrow(
            /TELEGRAM_WEBHOOK_SECRET: \[production\]/,
        )
        expect(
            validateEnv({
                ...PRODUCTION,
                TELEGRAM_BOT_TOKEN: '123:abc',
                TELEGRAM_WEBHOOK_SECRET: 'secret_1',
            }).TELEGRAM_WEBHOOK_SECRET,
        ).toBe('secret_1')
        // Polling, or the bot switched off, needs no secret.
        expect(() =>
            validateEnv({ ...PRODUCTION, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_MODE: 'polling' }),
        ).not.toThrow()
        expect(() =>
            validateEnv({
                ...PRODUCTION,
                TELEGRAM_BOT_TOKEN: '123:abc',
                TELEGRAM_ENABLED: 'false',
            }),
        ).not.toThrow()
    })
})

describe('envSchema (database pool)', () => {
    it('defaults the pool size and timeouts', () => {
        const env = validateEnv(BASE)
        expect(env.DB_POOL_MAX).toBe(10)
        expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(5000)
        expect(env.DB_IDLE_TX_TIMEOUT_MS).toBe(10_000)
        expect(env.DB_CONNECT_TIMEOUT_MS).toBe(3000)
    })

    it('coerces overrides and rejects a pool without connections', () => {
        const env = validateEnv({ ...BASE, DB_POOL_MAX: '4', DB_STATEMENT_TIMEOUT_MS: '0' })
        expect(env.DB_POOL_MAX).toBe(4)
        expect(env.DB_STATEMENT_TIMEOUT_MS).toBe(0)
        expect(envSchema.safeParse({ ...BASE, DB_POOL_MAX: '0' }).success).toBe(false)
    })
})
