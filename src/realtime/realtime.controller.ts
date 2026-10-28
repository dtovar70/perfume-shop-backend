import { Controller, type MessageEvent, Req, Sse } from '@nestjs/common'
import type { Observable } from 'rxjs'
import { Role } from '../auth/role.enum.js'
import { Public } from '../common/decorators/public.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import type { AuthenticatedRequest } from '../common/types/auth-user.js'
import { RealtimeService } from './realtime.service.js'

/**
 * Server-Sent Events: `data: {"type":"catalog"}` lines telling the client what to refetch. Nest
 * sends the stream headers (`no-cache`, `X-Accel-Buffering: no`) and lifts the socket timeout;
 * each connection counts once against the IP throttler. The order stream is in OrdersController.
 */
@Public()
@Controller('events')
export class RealtimeController {
    constructor(private readonly realtime: RealtimeService) {}

    /** The storefront: `catalog`, `catalogs`, `content` and `exchange-rate`. */
    @Sse()
    stream(): Observable<MessageEvent> {
        return this.realtime.publicStream()
    }
}

/** The back office: the public events plus `{ type: 'order', code }` (session cookie). */
@Roles(Role.ADMIN, Role.EDITOR)
@Controller('admin/events')
export class AdminRealtimeController {
    constructor(private readonly realtime: RealtimeService) {}

    @Sse()
    stream(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
        return this.realtime.adminStream(request.sessionToken?.expiresAt)
    }
}
