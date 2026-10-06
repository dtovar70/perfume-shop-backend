import { z } from 'zod'

/** "true"/"false" (and 1/0, yes/no) from the environment; unset or empty stays undefined. */
const optionalBoolean = z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .optional()
    .transform((value) => (value ? ['true', '1', 'yes'].includes(value) : undefined))

const optionalString = z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))

/** "pedidos@tienda.com" or "KaiZen Perfumería <pedidos@tienda.com>". */
const MAILBOX_PATTERN =
    /^(?:[^<>@]*<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/
const MAILBOX_MESSAGE = 'Use an address like "Name <pedidos@example.com>" or "pedidos@example.com"'

export const MAIL_DRIVERS = ['log', 'smtp', 'resend'] as const
export type MailDriver = (typeof MAIL_DRIVERS)[number]

/** Express `trust proxy` value: a hop count, or a list of names/addresses/CIDRs to trust. */
export type TrustProxy = number | string | false

/** Express's named ranges, or an IPv4/IPv6 address or CIDR. */
const TRUST_PROXY_ENTRY = /^(?:loopback|linklocal|uniquelocal|[0-9A-Fa-f.:]+(?:\/\d{1,3})?)$/

/**
 * TRUST_PROXY: "0"/"false" (no proxy), a hop count ("1" = one reverse proxy in front, e.g.
 * Caddy) or a comma-separated list like "loopback" or "10.0.0.0/8, 172.16.0.0/12". "true"
 * (trust every hop) is refused: any client could then spoof its IP with X-Forwarded-For.
 */
const trustProxy = optionalString.pipe(
    z
        .string()
        .optional()
        .transform((value, ctx): TrustProxy | undefined => {
            if (value === undefined) return undefined
            if (value === 'false') return false
            if (/^\d+$/.test(value)) {
                const hops = Number(value)
                return hops === 0 ? false : hops
            }
            const entries = value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean)
            if (!entries.length || !entries.every((entry) => TRUST_PROXY_ENTRY.test(entry))) {
                ctx.addIssue({
                    code: 'custom',
                    message:
                        'Use a hop count (e.g. 1), false, or names/CIDRs like "loopback" or "10.0.0.0/8"',
                })
                return z.NEVER
            }
            return entries.join(', ')
        }),
)

/** Hosts that only make sense on a developer's machine. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|.*\.localhost)$/i

function isLocalHost(hostname: string): boolean {
    return LOCAL_HOST.test(hostname)
}

/** True for an https URL whose host is not a local one. */
function isPublicHttps(url: string): boolean {
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:' && !isLocalHost(parsed.hostname)
    } catch {
        return false
    }
}

/** True when an origin (or a bare host) points at the developer's machine. */
function isLocalOrigin(origin: string): boolean {
    try {
        return isLocalHost(new URL(origin).hostname)
    } catch {
        return /localhost|127\.0\.0\.1/i.test(origin)
    }
}

/**
 * Unknown keys are stripped (z.object is not strict), so a leftover variable from an older
 * `.env` (e.g. the removed JWT_EXPIRES_IN) is ignored instead of breaking startup.
 */
const envObject = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * Express `trust proxy` (see `trustProxy` above). Default: 1 in production (one reverse
     * proxy, Caddy, in front of the API), off elsewhere.
     */
    TRUST_PROXY: trustProxy,
    PUBLIC_API_URL: z
        .url()
        .default('http://localhost:3000')
        .transform((value) => value.replace(/\/+$/, '')),
    /**
     * Public address of the storefront, used to build the customer's order links
     * (`<PUBLIC_SITE_URL>/pedido/KZ-000123?t=…`) the admin sends by WhatsApp.
     */
    PUBLIC_SITE_URL: z
        .url()
        .default('http://localhost:5173')
        .transform((value) => value.replace(/\/+$/, '')),
    CORS_ORIGIN: z
        .string()
        .default('http://localhost:5173')
        .transform((value) =>
            value
                .split(',')
                .map((origin) => origin.trim())
                .filter(Boolean),
        ),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
    /** Admin inactivity limit before the "extend session?" prompt shows up. */
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    /** Countdown of that prompt; the session closes when it reaches 0. */
    SESSION_PROMPT_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
    CLOUDINARY_CLOUD_NAME: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,
    /** Hours a new order waits for its payment before it expires (fractions allowed). */
    ORDER_PAYMENT_WINDOW_HOURS: z.coerce.number().positive().max(720).default(24),
    /** How often unpaid orders past their deadline are expired. */
    ORDER_EXPIRY_INTERVAL_MINUTES: z.coerce.number().positive().max(1440).default(10),
    /**
     * Hours from the start of a rate's "fecha valor" (Caracas) during which checkout may use it.
     * The default, 24, ends at the close of the fecha valor day: the BCV publishes the next
     * business day's rate the afternoon before, so a newer rate should always be there by then.
     */
    EXCHANGE_RATE_MAX_AGE_HOURS: z.coerce.number().positive().max(720).default(24),
    /** How often the BCV rate is fetched (it is also fetched at startup). */
    EXCHANGE_RATE_SYNC_INTERVAL_MINUTES: z.coerce.number().positive().max(1440).default(120),
    /**
     * Background jobs (rate sync, order expiry). Default: on, except under NODE_ENV=test so the
     * test suites never reach the network or the scheduler.
     */
    SCHEDULED_JOBS_ENABLED: optionalBoolean,
    /** Token of the Telegram bot (@BotFather). Without it the bot stays off. Never logged. */
    TELEGRAM_BOT_TOKEN: optionalString,
    /**
     * Turns the bot off even with a token. Default: on when a token exists, except under
     * NODE_ENV=test so the test suites never reach Telegram.
     */
    TELEGRAM_ENABLED: optionalBoolean,
    /** `polling` (default outside production) or `webhook` (default in production). */
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).optional(),
    /**
     * Secret Telegram sends in `X-Telegram-Bot-Api-Secret-Token` on every webhook call. Required
     * in webhook mode; 1–256 characters of A-Z, a-z, 0-9, `_` and `-` (Telegram's rule).
     */
    TELEGRAM_WEBHOOK_SECRET: optionalString.pipe(
        z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,256}$/, 'Use 1-256 characters: letters, digits, _ or -')
            .optional(),
    ),
    /** Bot API server (tests point it to a fake one). Default: https://api.telegram.org. */
    TELEGRAM_API_ROOT: z
        .url()
        .optional()
        .transform((value) => value?.replace(/\/+$/, '')),
    /**
     * How customer and password-reset emails leave the server: `log` (default: nothing is sent,
     * only the masked recipient and the subject are logged), `smtp` (e.g. Mailpit in development)
     * or `resend` (Resend's HTTP API, production). NODE_ENV=test always uses `log`.
     */
    MAIL_DRIVER: z.enum(MAIL_DRIVERS).default('log'),
    /** Sender of every email. Required by `smtp` and `resend`. */
    MAIL_FROM: optionalString.pipe(z.string().regex(MAILBOX_PATTERN, MAILBOX_MESSAGE).optional()),
    /** Where the customer's replies go (optional; without it, replies go to MAIL_FROM). */
    MAIL_REPLY_TO: optionalString.pipe(
        z.string().regex(MAILBOX_PATTERN, MAILBOX_MESSAGE).optional(),
    ),
    SMTP_HOST: optionalString,
    SMTP_PORT: optionalString.pipe(z.coerce.number<string>().int().min(1).max(65535).optional()),
    /** Optional: Mailpit needs no login. Set both or neither. Never logged. */
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    /** Resend API key ("re_…"). Required by `resend`. Never logged. */
    RESEND_API_KEY: optionalString,
})

export const envSchema = envObject.superRefine((env, ctx) => {
    const need = (key: keyof typeof env, why: string) => {
        if (env[key] === undefined) {
            ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required ${why}` })
        }
    }
    if (env.MAIL_DRIVER === 'smtp') {
        need('MAIL_FROM', 'when MAIL_DRIVER=smtp')
        need('SMTP_HOST', 'when MAIL_DRIVER=smtp')
        need('SMTP_PORT', 'when MAIL_DRIVER=smtp')
        if (env.SMTP_USER !== undefined || env.SMTP_PASS !== undefined) {
            need('SMTP_USER', 'together with SMTP_PASS')
            need('SMTP_PASS', 'together with SMTP_USER')
        }
    }
    if (env.MAIL_DRIVER === 'resend') {
        need('MAIL_FROM', 'when MAIL_DRIVER=resend')
        need('RESEND_API_KEY', 'when MAIL_DRIVER=resend')
    }
    if (env.NODE_ENV === 'production') checkProduction(env, ctx)
})

type ParsedEnv = z.output<typeof envObject>

/**
 * NODE_ENV=production refuses the development defaults instead of running half-configured:
 * local URLs, local-disk images, emails that are only logged, an unauthenticated webhook.
 * Each message says what to set (English for the operator, Spanish summary after the dash).
 */
function checkProduction(env: ParsedEnv, ctx: z.RefinementCtx): void {
    const fail = (key: keyof ParsedEnv, message: string) => {
        ctx.addIssue({ code: 'custom', path: [key], message: `[production] ${message}` })
    }
    for (const key of ['PUBLIC_API_URL', 'PUBLIC_SITE_URL'] as const) {
        if (!isPublicHttps(env[key])) {
            fail(
                key,
                `${key} must be a public https:// URL, not localhost (got "${env[key]}") — en producción debe ser https y con un dominio público`,
            )
        }
    }
    const localOrigins = env.CORS_ORIGIN.filter(isLocalOrigin)
    if (!env.CORS_ORIGIN.length || localOrigins.length) {
        fail(
            'CORS_ORIGIN',
            `CORS_ORIGIN must list the storefront's public origin(s), without localhost${localOrigins.length ? ` (remove ${localOrigins.join(', ')})` : ''} — indica el dominio público de la tienda`,
        )
    }
    const cloudinary = (
        ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const
    ).filter((key) => env[key] === undefined)
    for (const key of cloudinary) {
        fail(
            key,
            `${key} is required (images are never stored on the server's disk in production) — falta configurar Cloudinary`,
        )
    }
    if (env.MAIL_DRIVER === 'log') {
        fail(
            'MAIL_DRIVER',
            'MAIL_DRIVER must be "resend" (or "smtp" with a real server); "log" sends nothing — los correos no se enviarían',
        )
    }
    if (env.MAIL_DRIVER === 'smtp' && env.SMTP_HOST !== undefined && isLocalHost(env.SMTP_HOST)) {
        fail(
            'SMTP_HOST',
            `SMTP_HOST must be a real mail server, not "${env.SMTP_HOST}" — el servidor SMTP no puede ser local`,
        )
    }
    const telegramOn = env.TELEGRAM_BOT_TOKEN !== undefined && env.TELEGRAM_ENABLED !== false
    if (
        telegramOn &&
        (env.TELEGRAM_MODE ?? 'webhook') === 'webhook' &&
        env.TELEGRAM_WEBHOOK_SECRET === undefined
    ) {
        fail(
            'TELEGRAM_WEBHOOK_SECRET',
            'TELEGRAM_WEBHOOK_SECRET is required for the Telegram webhook — sin él cualquiera podría enviar actualizaciones falsas',
        )
    }
}

export type Env = z.infer<typeof envSchema>

/** Used by ConfigModule: fails fast at startup with a readable list of invalid variables. */
export function validateEnv(config: Record<string, unknown>): Env {
    const result = envSchema.safeParse(config)
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
            .join('\n')
        throw new Error(`Invalid environment variables:\n${issues}`)
    }
    return result.data
}
