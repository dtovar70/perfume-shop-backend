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
    Query,
    UploadedFiles,
    UseFilters,
    UseInterceptors,
} from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import { InvalidatesCache } from '../cache/invalidates-cache.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import { Role } from '../auth/role.enum.js'
import { AdminProductsService } from './admin-products.service.js'
import { AdminProductQueryDto } from './dto/admin-product-query.dto.js'
import { CreateProductDto } from './dto/create-product.dto.js'
import { ReorderImagesDto } from './dto/reorder-images.dto.js'
import { SetActiveDto } from './dto/set-active.dto.js'
import { UpdateProductDto } from './dto/update-product.dto.js'
import { ProductImagesService } from './product-images.service.js'
import type { AdminProductDto, Paginated } from './product.mapper.js'
import { MAX_IMAGES_PER_UPLOAD } from './products.constants.js'
import { PRODUCT_IMAGES_FIELD, PRODUCT_IMAGES_UPLOAD } from './product-images-upload.js'

@Roles(Role.ADMIN, Role.EDITOR)
@InvalidatesCache('catalog')
@Controller('admin/products')
export class AdminProductsController {
    constructor(
        private readonly products: AdminProductsService,
        private readonly images: ProductImagesService,
    ) {}

    @Get()
    list(@Query() query: AdminProductQueryDto): Promise<Paginated<AdminProductDto>> {
        return this.products.list(query)
    }

    @Get(':id')
    get(@Param('id') id: string): Promise<AdminProductDto> {
        return this.products.get(id)
    }

    @Post()
    create(@Body() dto: CreateProductDto): Promise<AdminProductDto> {
        return this.products.create(dto)
    }

    @Patch(':id')
    update(@Param('id') id: string, @Body() dto: UpdateProductDto): Promise<AdminProductDto> {
        return this.products.update(id, dto)
    }

    /** Body `{ isActive }` sets the value; an empty body toggles it. */
    @Patch(':id/active')
    setActive(@Param('id') id: string, @Body() dto: SetActiveDto): Promise<AdminProductDto> {
        return this.products.setActive(id, dto.isActive)
    }

    @Roles(Role.ADMIN)
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    remove(@Param('id') id: string): Promise<void> {
        return this.products.remove(id)
    }

    @Post(':id/images')
    @UseFilters(PRODUCT_IMAGES_UPLOAD.filter)
    @UseInterceptors(
        FilesInterceptor(
            PRODUCT_IMAGES_FIELD,
            MAX_IMAGES_PER_UPLOAD,
            PRODUCT_IMAGES_UPLOAD.options,
        ),
    )
    uploadImages(
        @Param('id') id: string,
        @UploadedFiles() files: Express.Multer.File[] | undefined,
    ): Promise<AdminProductDto> {
        return this.images.upload(id, files ?? [])
    }

    @Patch(':id/images/order')
    reorderImages(
        @Param('id') id: string,
        @Body() dto: ReorderImagesDto,
    ): Promise<AdminProductDto> {
        return this.images.reorder(id, dto.imageIds)
    }

    @Delete(':id/images/:imageId')
    removeImage(
        @Param('id') id: string,
        @Param('imageId') imageId: string,
    ): Promise<AdminProductDto> {
        return this.images.remove(id, imageId)
    }
}
