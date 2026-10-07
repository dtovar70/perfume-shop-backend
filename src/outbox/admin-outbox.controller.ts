import { Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import { Role } from '../auth/role.enum.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import type { Paginated } from '../products/product.mapper.js'
import { OutboxQueryDto } from './dto/outbox-query.dto.js'
import { OutboxService, type AdminOutboxMessageDto } from './outbox.service.js'

/** Notification delivery: what is waiting or gave up (`?status=failed`), and retrying it. ADMIN only. */
@Roles(Role.ADMIN)
@Controller('admin/outbox')
export class AdminOutboxController {
    constructor(private readonly outbox: OutboxService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    list(@Query() query: OutboxQueryDto): Promise<Paginated<AdminOutboxMessageDto>> {
        return this.outbox.list(query)
    }

    @Post(':id/retry')
    @HttpCode(HttpStatus.OK)
    retry(@Param('id') id: string): Promise<AdminOutboxMessageDto> {
        return this.outbox.retry(id)
    }
}
