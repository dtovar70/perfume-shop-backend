import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Brand } from '../brands/entities/brand.entity.js'
import { Product } from '../products/entities/product.entity.js'
import { SitemapController } from './sitemap.controller.js'
import { SitemapService } from './sitemap.service.js'

@Module({
    imports: [TypeOrmModule.forFeature([Product, Brand])],
    controllers: [SitemapController],
    providers: [SitemapService],
})
export class SitemapModule {}
