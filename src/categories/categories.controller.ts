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
import { Public } from '../common/decorators/public.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import { Role } from '../auth/role.enum.js'
import {
    CATEGORY_ORDER_ROUTE,
    CategoriesService,
    type AdminCategoryDto,
    type CategoryDto,
} from './categories.service.js'
import {
    CATEGORY_IMAGE_FIELD,
    CATEGORY_IMAGE_UPLOAD_OPTIONS,
    CategoryImageUploadErrorsFilter,
} from './category-image-upload.js'
import { CreateCategoryDto } from './dto/create-category.dto.js'
import { ReorderCategoriesDto } from './dto/reorder-categories.dto.js'
import { UpdateCategoryDto } from './dto/update-category.dto.js'

@Public()
@Controller('categories')
export class CategoriesController {
    constructor(private readonly categories: CategoriesService) {}

    @Get()
    list(): Promise<CategoryDto[]> {
        return this.categories.list()
    }
}

/**
 * Create and update take JSON or multipart/form-data with an optional `image` cover (JPG, PNG,
 * WEBP or AVIF checked by its bytes, at most 5 MB), stored under `categories/`.
 */
@Roles(Role.ADMIN, Role.EDITOR)
@Controller('admin/categories')
export class AdminCategoriesController {
    constructor(private readonly categories: CategoriesService) {}

    @Get()
    list(): Promise<AdminCategoryDto[]> {
        return this.categories.listForAdmin()
    }

    @Post()
    @UseFilters(CategoryImageUploadErrorsFilter)
    @UseInterceptors(FileInterceptor(CATEGORY_IMAGE_FIELD, CATEGORY_IMAGE_UPLOAD_OPTIONS))
    create(
        @Body() dto: CreateCategoryDto,
        @UploadedFile() image: Express.Multer.File | undefined,
    ): Promise<AdminCategoryDto> {
        return this.categories.create(dto, image)
    }

    /**
     * Sets the menu order from the full list of slugs. Declared before `PATCH :slug` so "order"
     * is never matched as a slug (and "order" is reserved, so no category can use it).
     */
    @Patch(CATEGORY_ORDER_ROUTE)
    reorder(@Body() dto: ReorderCategoriesDto): Promise<AdminCategoryDto[]> {
        return this.categories.reorder(dto.slugs)
    }

    @Patch(':slug')
    @UseFilters(CategoryImageUploadErrorsFilter)
    @UseInterceptors(FileInterceptor(CATEGORY_IMAGE_FIELD, CATEGORY_IMAGE_UPLOAD_OPTIONS))
    update(
        @Param('slug') slug: string,
        @Body() dto: UpdateCategoryDto,
        @UploadedFile() image: Express.Multer.File | undefined,
    ): Promise<AdminCategoryDto> {
        return this.categories.update(slug, dto, image)
    }

    /** Refused with 409 while the category still has products (active or hidden). */
    @Roles(Role.ADMIN)
    @Delete(':slug')
    @HttpCode(HttpStatus.NO_CONTENT)
    remove(@Param('slug') slug: string): Promise<void> {
        return this.categories.remove(slug)
    }
}
