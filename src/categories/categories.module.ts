import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Product } from '../products/entities/product.entity.js'
import { AdminCategoriesController, CategoriesController } from './categories.controller.js'
import { CategoriesService } from './categories.service.js'
import { Category } from './entities/category.entity.js'

@Module({
    imports: [TypeOrmModule.forFeature([Category, Product])],
    controllers: [CategoriesController, AdminCategoriesController],
    providers: [CategoriesService],
})
export class CategoriesModule {}
