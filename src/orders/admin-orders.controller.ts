import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Res,
    UploadedFile,
    UseFilters,
    UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { Role } from '../auth/role.enum.js'
import { CurrentUser } from '../common/decorators/current-user.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import type { AuthUser } from '../common/types/auth-user.js'
import {
    AdminOrdersService,
    type AdminOrderListDto,
    type AdminOrdersSummaryDto,
} from './admin-orders.service.js'
import { AdminOrderQueryDto } from './dto/admin-order-query.dto.js'
import { SubmitPaymentDto } from './dto/submit-payment.dto.js'
import { AddOrderNoteDto, MarkRefundedDto, TransitionOrderDto } from './dto/transition-order.dto.js'
import type { AdminOrderDto } from './order.mapper.js'
import { OrderAccessService, type IssuedAccessLink } from './order-access.service.js'
import { ReceiptService } from './receipt/receipt.service.js'
import { sendReceipt } from './receipt/send-receipt.js'
import { OrderWhatsAppService, type WhatsAppMessageDto } from './whatsapp/order-whatsapp.service.js'
import { PROOF_FIELD, PROOF_UPLOAD } from './payment-upload.js'

/**
 * Back office. ADMIN and EDITOR can do everything except cancelling an order, which the
 * transition map reserves for ADMIN (403 for an EDITOR).
 */
@Roles(Role.ADMIN, Role.EDITOR)
@Controller('admin/orders')
export class AdminOrdersController {
    constructor(
        private readonly orders: AdminOrdersService,
        private readonly access: OrderAccessService,
        private readonly receipts: ReceiptService,
        private readonly whatsapp: OrderWhatsAppService,
    ) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    list(@Query() query: AdminOrderQueryDto): Promise<AdminOrderListDto> {
        return this.orders.list(query)
    }

    /** Nav badge (orders waiting for verification) and page warnings. */
    @Get('summary')
    @Header('Cache-Control', 'no-store')
    summary(): Promise<AdminOrdersSummaryDto> {
        return this.orders.summary()
    }

    @Get(':code')
    @Header('Cache-Control', 'no-store')
    get(@Param('code') code: string, @CurrentUser() user: AuthUser): Promise<AdminOrderDto> {
        return this.orders.get(code, user)
    }

    /**
     * `{ to, note?, acknowledgeStockConflict?, forceStock?, refundStatus?, refundReference? }`:
     * one allowed status change (see ORDER_TRANSITIONS).
     */
    @Post(':code/transitions')
    @HttpCode(HttpStatus.OK)
    transition(
        @Param('code') code: string,
        @Body() dto: TransitionOrderDto,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminOrderDto> {
        return this.orders.transition(code, dto, user)
    }

    /**
     * "Registrar pago manualmente": the same multipart form as the customer's proof, for a
     * payment reported by WhatsApp. Recorded with source `admin` and the current user.
     */
    @Post(':code/payments')
    @HttpCode(HttpStatus.OK)
    @UseFilters(PROOF_UPLOAD.filter)
    @UseInterceptors(FileInterceptor(PROOF_FIELD, PROOF_UPLOAD.options))
    recordPayment(
        @Param('code') code: string,
        @Body() dto: SubmitPaymentDto,
        @UploadedFile() file: Express.Multer.File | undefined,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminOrderDto> {
        return this.orders.recordPayment(code, dto, file, user)
    }

    /** `{ reference? }`: the money of a cancelled order was given back. */
    @Post(':code/refund')
    @HttpCode(HttpStatus.OK)
    markRefunded(
        @Param('code') code: string,
        @Body() dto: MarkRefundedDto,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminOrderDto> {
        return this.orders.markRefunded(code, dto.reference, user)
    }

    @Post(':code/notes')
    @HttpCode(HttpStatus.OK)
    addNote(
        @Param('code') code: string,
        @Body() dto: AddOrderNoteDto,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminOrderDto> {
        return this.orders.addNote(code, dto.body, user)
    }

    /**
     * Issues a new private link for the customer and returns it once (`{ token, url, createdAt }`):
     * only the hash is stored, so the old links cannot be shown again. They keep working.
     */
    @Post(':code/access-links')
    @Header('Cache-Control', 'no-store')
    issueAccessLink(
        @Param('code') code: string,
        @CurrentUser() user: AuthUser,
    ): Promise<IssuedAccessLink> {
        return this.access.issueForCode(code, user.id)
    }

    /**
     * "Avisar por WhatsApp": the current status's template rendered for this order, with a fresh
     * link when it uses one → `{ phone, text, url, … }` (`url` is the wa.me link).
     */
    @Post(':code/whatsapp-message')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    whatsappMessage(
        @Param('code') code: string,
        @CurrentUser() user: AuthUser,
    ): Promise<WhatsAppMessageDto> {
        return this.whatsapp.prepare(code, user.id)
    }

    /** The owner opened WhatsApp with the message: an internal note keeps the trace. */
    @Post(':code/whatsapp-message/opened')
    @HttpCode(HttpStatus.OK)
    async whatsappOpened(
        @Param('code') code: string,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminOrderDto> {
        await this.whatsapp.recordOpened(code, user)
        return this.orders.get(code, user)
    }

    /** The purchase receipt PDF (409 until the payment is verified, and once cancelled). */
    @Get(':code/receipt.pdf')
    async receipt(
        @Param('code') code: string,
        @CurrentUser() user: AuthUser,
        @Res() res: Response,
    ): Promise<void> {
        sendReceipt(res, await this.receipts.forAdmin(code, user.id))
    }

    /**
     * The payment screenshot. Local disk: streamed from the private folder. Cloudinary: a
     * redirect to a download URL signed for a few minutes. Never cached.
     */
    @Get(':code/payments/:paymentId/proof')
    async proof(
        @Param('code') code: string,
        @Param('paymentId') paymentId: string,
        @Res() res: Response,
    ): Promise<void> {
        const access = await this.orders.paymentProof(code, paymentId)
        res.setHeader('Cache-Control', 'private, no-store')
        if (access.kind === 'redirect') {
            res.redirect(HttpStatus.FOUND, access.url)
            return
        }
        res.setHeader('Content-Type', access.contentType)
        res.setHeader('Content-Length', String(access.size))
        res.setHeader('Content-Disposition', 'inline')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        access.stream.on('error', () => res.destroy())
        access.stream.pipe(res)
    }
}
