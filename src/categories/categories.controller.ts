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
} from '@nestjs/common'
import { Public } from '../common/decorators/public.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import { Role } from '../auth/role.enum.js'
import {
    CATEGORY_ORDER_ROUTE,
    CategoriesService,
    type AdminCategoryDto,
    type CategoryDto,
} from './categories.service.js'
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

@Roles(Role.ADMIN, Role.EDITOR)
@Controller('admin/categories')
export class AdminCategoriesController {
    constructor(private readonly categories: CategoriesService) {}

    @Get()
    list(): Promise<AdminCategoryDto[]> {
        return this.categories.listForAdmin()
    }

    @Post()
    create(@Body() dto: CreateCategoryDto): Promise<AdminCategoryDto> {
        return this.categories.create(dto)
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
    update(@Param('slug') slug: string, @Body() dto: UpdateCategoryDto): Promise<AdminCategoryDto> {
        return this.categories.update(slug, dto)
    }

    /** Refused with 409 while the category still has products (active or hidden). */
    @Roles(Role.ADMIN)
    @Delete(':slug')
    @HttpCode(HttpStatus.NO_CONTENT)
    remove(@Param('slug') slug: string): Promise<void> {
        return this.categories.remove(slug)
    }
}
