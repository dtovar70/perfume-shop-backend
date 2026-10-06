import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js'
import type { AuthenticatedRequest, JwtClaims } from '../../common/types/auth-user.js'
import type { Env } from '../../config/env.schema.js'
import { SESSION_COOKIE, toAuthUser } from '../auth.constants.js'
import { User } from '../entities/user.entity.js'
import {
    issuedBeforePasswordChange,
    sessionSettingsFrom,
    tokenLifetime,
} from '../session.config.js'

const INVALID_SESSION = 'Tu sesión expiró o no es válida. Inicia sesión de nuevo.'
const SESSION_REVOKED = 'Tu sesión ya no es válida. Inicia sesión de nuevo.'
const PASSWORD_CHANGED = 'Tu contraseña cambió. Inicia sesión de nuevo con la nueva contraseña.'

/**
 * Global guard: every route requires a valid `kz_session` cookie unless marked @Public().
 * The user is re-read from the database on every request, so a deactivation, a role change
 * or a password change (which rejects older tokens) applies immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
    private readonly ttlSeconds: number

    constructor(
        private readonly reflector: Reflector,
        private readonly jwt: JwtService,
        @InjectRepository(User) private readonly users: Repository<User>,
        config: ConfigService<Env, true>,
    ) {
        this.ttlSeconds = sessionSettingsFrom(config).ttlSeconds
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ])
        if (isPublic) return true

        const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
        const cookies = request.cookies as Record<string, string | undefined> | undefined
        const token = cookies?.[SESSION_COOKIE]
        if (!token) {
            throw new UnauthorizedException('Debes iniciar sesión para continuar.')
        }

        let claims: JwtClaims
        try {
            claims = await this.jwt.verifyAsync<JwtClaims>(token)
        } catch {
            throw new UnauthorizedException(INVALID_SESSION)
        }

        // Tokens longer than the configured lifetime (e.g. issued before the idle timeout
        // existed) would bypass it, so they are rejected like expired ones.
        const lifetime = tokenLifetime(claims, this.ttlSeconds)
        if (!lifetime || claims.iat === undefined) {
            throw new UnauthorizedException(INVALID_SESSION)
        }

        const user = await this.users.findOneBy({ id: claims.sub })
        if (!user || !user.isActive) {
            throw new UnauthorizedException(SESSION_REVOKED)
        }
        if (issuedBeforePasswordChange(claims.iat, user.passwordChangedAt ?? null)) {
            throw new UnauthorizedException(PASSWORD_CHANGED)
        }

        request.user = toAuthUser(user)
        request.sessionToken = lifetime
        return true
    }
}
