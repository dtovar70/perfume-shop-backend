import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import { masculine, msg } from '../../common/validation/messages.js'
import { OUTBOX_STATUSES, type OutboxStatus } from '../entities/outbox-message.entity.js'

export const OUTBOX_DEFAULT_PAGE_SIZE = 20
export const OUTBOX_MAX_PAGE_SIZE = 100

const STATUS = masculine('El estado')
const PAGE = masculine('El número de página')
const PAGE_SIZE = masculine('El tamaño de página')

/** `GET /admin/outbox?status&page&pageSize`. */
export class OutboxQueryDto {
    @IsOptional()
    @IsIn(OUTBOX_STATUSES, {
        message: `${msg.invalid(STATUS)} Usa ${OUTBOX_STATUSES.join(', ')}.`,
    })
    status?: OutboxStatus

    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: msg.integer(PAGE) })
    @Min(1, { message: msg.min(PAGE, 1) })
    page: number = 1

    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: msg.integer(PAGE_SIZE) })
    @Min(1, { message: msg.min(PAGE_SIZE, 1) })
    @Max(OUTBOX_MAX_PAGE_SIZE, { message: msg.max(PAGE_SIZE, OUTBOX_MAX_PAGE_SIZE) })
    pageSize: number = OUTBOX_DEFAULT_PAGE_SIZE
}
