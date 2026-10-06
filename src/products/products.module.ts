import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Brand } from '../brands/entities/brand.entity.js'
import { Category } from '../categories/entities/category.entity.js'
import { AdminProductsController } from './admin-products.controller.js'
import { AdminProductsService } from './admin-products.service.js'
import { CatalogController } from './catalog.controller.js'
import { CatalogService } from './catalog.service.js'
import { ProductImage } from './entities/product-image.entity.js'
import { ProductVariant } from './entities/product-variant.entity.js'
import { Product } from './entities/product.entity.js'
import { ProductImagesService } from './product-images.service.js'
import { ProductRepository } from './product.repository.js'

@Module({
    imports: [TypeOrmModule.forFeature([Product, ProductVariant, ProductImage, Category, Brand])],
    controllers: [CatalogController, AdminProductsController],
    providers: [CatalogService, AdminProductsService, ProductImagesService, ProductRepository],
})
export class ProductsModule {}
