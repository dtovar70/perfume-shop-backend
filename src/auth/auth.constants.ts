import type { AuthUser } from '../common/types/auth-user.js'
import type { User } from './entities/user.entity.js'

export const SESSION_COOKIE = 'kz_session'

/** Explicit projection so the password hash can never leak into a response. */
export function toAuthUser(user: User): AuthUser {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    }
}
