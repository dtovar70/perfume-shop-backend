import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Product } from '../products/entities/product.entity.js'
import { AdminBrandsController, BrandsController } from './brands.controller.js'
import { BrandsService } from './brands.service.js'
import { Brand } from './entities/brand.entity.js'

@Module({
    imports: [TypeOrmModule.forFeature([Brand, Product])],
    controllers: [BrandsController, AdminBrandsController],
    providers: [BrandsService],
})
export class BrandsModule {}
