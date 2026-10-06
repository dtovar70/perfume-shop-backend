import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    UploadedFile,
    UseFilters,
    UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Role } from '../auth/role.enum.js'
import { Public } from '../common/decorators/public.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import { LOGO_FIELD, LOGO_UPLOAD_OPTIONS, LogoUploadErrorsFilter } from './brand-logo-upload.js'
import { BrandsService, type AdminBrandDto, type PublicBrandDto } from './brands.service.js'
import { CreateBrandDto } from './dto/create-brand.dto.js'
import { UpdateBrandDto } from './dto/update-brand.dto.js'

@Public()
@Controller('brands')
export class BrandsController {
    constructor(private readonly brands: BrandsService) {}

    @Get()
    list(): Promise<PublicBrandDto[]> {
        return this.brands.list()
    }
}

/**
 * Create and update take JSON or multipart/form-data with an optional `logo` image (JPG, PNG or
 * WEBP checked by its bytes, at most 2 MB), stored like the product photos.
 */
@Roles(Role.ADMIN, Role.EDITOR)
@Controller('admin/brands')
export class AdminBrandsController {
    constructor(private readonly brands: BrandsService) {}

    @Get()
    list(): Promise<AdminBrandDto[]> {
        return this.brands.listForAdmin()
    }

    @Get(':slug')
    get(@Param('slug') slug: string): Promise<AdminBrandDto> {
        return this.brands.get(slug)
    }

    @Post()
    @UseFilters(LogoUploadErrorsFilter)
    @UseInterceptors(FileInterceptor(LOGO_FIELD, LOGO_UPLOAD_OPTIONS))
    create(
        @Body() dto: CreateBrandDto,
        @UploadedFile() logo: Express.Multer.File | undefined,
    ): Promise<AdminBrandDto> {
        return this.brands.create(dto, logo)
    }

    @Patch(':slug')
    @UseFilters(LogoUploadErrorsFilter)
    @UseInterceptors(FileInterceptor(LOGO_FIELD, LOGO_UPLOAD_OPTIONS))
    update(
        @Param('slug') slug: string,
        @Body() dto: UpdateBrandDto,
        @UploadedFile() logo: Express.Multer.File | undefined,
    ): Promise<AdminBrandDto> {
        return this.brands.update(slug, dto, logo)
    }

    /** Its products stay, without a brand. */
    @Roles(Role.ADMIN)
    @Delete(':slug')
    @HttpCode(HttpStatus.NO_CONTENT)
    remove(@Param('slug') slug: string): Promise<void> {
        return this.brands.remove(slug)
    }
}
