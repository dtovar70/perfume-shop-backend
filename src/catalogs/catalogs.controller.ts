import {
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
} from '@nestjs/common'
import { Role } from '../auth/role.enum.js'
import { InvalidatesCache } from '../cache/invalidates-cache.decorator.js'
import { Public } from '../common/decorators/public.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import { BANK_ORDER_ROUTE, BanksService, type AdminBankDto, type BankDto } from './banks.service.js'
import { CreateBankDto } from './dto/create-bank.dto.js'
import { CreateMobilePrefixDto } from './dto/create-mobile-prefix.dto.js'
import { ReorderBanksDto } from './dto/reorder-banks.dto.js'
import { ReorderMobilePrefixesDto } from './dto/reorder-mobile-prefixes.dto.js'
import { UpdateBankDto } from './dto/update-bank.dto.js'
import { UpdateMobilePrefixDto } from './dto/update-mobile-prefix.dto.js'
import { UpdateOrderStatusGroupDto } from './dto/update-order-status-group.dto.js'
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js'
import {
    MOBILE_PREFIX_ORDER_ROUTE,
    MobilePrefixesService,
    type AdminMobilePrefixDto,
    type MobilePrefixDto,
} from './mobile-prefixes.service.js'
import {
    OrderStatusCatalogService,
    type AdminOrderStatusCatalogDto,
    type OrderStatusCatalogDto,
} from './order-status-catalog.service.js'

/**
 * Public catalogs. Like `GET /content`, `no-cache` lets browsers keep a copy but revalidate it
 * on every load; Express adds a weak ETag, so an unchanged catalog costs a 304.
 */
@Public()
@Controller('catalogs')
export class CatalogsController {
    constructor(
        private readonly orderStatuses: OrderStatusCatalogService,
        private readonly banks: BanksService,
        private readonly mobilePrefixes: MobilePrefixesService,
    ) {}

    /** Labels, customer copy, badge tones and tabs of the order statuses. */
    @Get('order-statuses')
    @Header('Cache-Control', 'no-cache')
    getOrderStatuses(): Promise<OrderStatusCatalogDto> {
        return this.orderStatuses.getCatalog()
    }

    /** Active banks, in select order. */
    @Get('banks')
    @Header('Cache-Control', 'no-cache')
    getBanks(): Promise<BankDto[]> {
        return this.banks.listActive()
    }

    /** Active mobile operator codes ("0424"), in select order. */
    @Get('mobile-prefixes')
    @Header('Cache-Control', 'no-cache')
    getMobilePrefixes(): Promise<MobilePrefixDto[]> {
        return this.mobilePrefixes.listActive()
    }
}

/**
 * Catalog editing (ADMIN only). Status codes, their group and `isTerminal` are fixed: the order
 * workflow depends on them, so the DTOs do not accept them (400). Every write tells the open
 * storefronts to refetch the catalogs (checkout banks, status labels).
 */
@Roles(Role.ADMIN)
@InvalidatesCache('catalogs')
@Controller('admin/catalogs')
export class AdminCatalogsController {
    constructor(
        private readonly orderStatuses: OrderStatusCatalogService,
        private readonly banks: BanksService,
        private readonly mobilePrefixes: MobilePrefixesService,
    ) {}

    @Get('order-statuses')
    @Header('Cache-Control', 'no-store')
    getOrderStatuses(): Promise<AdminOrderStatusCatalogDto> {
        return this.orderStatuses.getAdminCatalog()
    }

    /** Declared before `order-statuses/:code` for readability; the paths never overlap. */
    @Patch('order-statuses/groups/:code')
    updateGroup(
        @Param('code') code: string,
        @Body() dto: UpdateOrderStatusGroupDto,
    ): Promise<AdminOrderStatusCatalogDto> {
        return this.orderStatuses.updateGroup(code, dto)
    }

    @Patch('order-statuses/:code')
    updateStatus(
        @Param('code') code: string,
        @Body() dto: UpdateOrderStatusDto,
    ): Promise<AdminOrderStatusCatalogDto> {
        return this.orderStatuses.updateStatus(code, dto)
    }

    @Get('banks')
    @Header('Cache-Control', 'no-store')
    listBanks(): Promise<AdminBankDto[]> {
        return this.banks.listForAdmin()
    }

    @Post('banks')
    createBank(@Body() dto: CreateBankDto): Promise<AdminBankDto> {
        return this.banks.create(dto)
    }

    /** Declared before `PATCH banks/:code` so "order" is never taken for a code. */
    @Patch(`banks/${BANK_ORDER_ROUTE}`)
    reorderBanks(@Body() dto: ReorderBanksDto): Promise<AdminBankDto[]> {
        return this.banks.reorder(dto.codes)
    }

    @Patch('banks/:code')
    updateBank(@Param('code') code: string, @Body() dto: UpdateBankDto): Promise<AdminBankDto> {
        return this.banks.update(code, dto)
    }

    /** `409` while a payment or the Pago Móvil details use the bank: deactivate it instead. */
    @Delete('banks/:code')
    @HttpCode(HttpStatus.NO_CONTENT)
    removeBank(@Param('code') code: string): Promise<void> {
        return this.banks.remove(code)
    }

    @Get('mobile-prefixes')
    @Header('Cache-Control', 'no-store')
    listMobilePrefixes(): Promise<AdminMobilePrefixDto[]> {
        return this.mobilePrefixes.listForAdmin()
    }

    @Post('mobile-prefixes')
    createMobilePrefix(@Body() dto: CreateMobilePrefixDto): Promise<AdminMobilePrefixDto> {
        return this.mobilePrefixes.create(dto)
    }

    /** Declared before `PATCH mobile-prefixes/:code` so "order" is never taken for a code. */
    @Patch(`mobile-prefixes/${MOBILE_PREFIX_ORDER_ROUTE}`)
    reorderMobilePrefixes(@Body() dto: ReorderMobilePrefixesDto): Promise<AdminMobilePrefixDto[]> {
        return this.mobilePrefixes.reorder(dto.codes)
    }

    @Patch('mobile-prefixes/:code')
    updateMobilePrefix(
        @Param('code') code: string,
        @Body() dto: UpdateMobilePrefixDto,
    ): Promise<AdminMobilePrefixDto> {
        return this.mobilePrefixes.update(code, dto)
    }

    /** `409` while an order in progress or the store content uses the code: deactivate it. */
    @Delete('mobile-prefixes/:code')
    @HttpCode(HttpStatus.NO_CONTENT)
    removeMobilePrefix(@Param('code') code: string): Promise<void> {
        return this.mobilePrefixes.remove(code)
    }
}
