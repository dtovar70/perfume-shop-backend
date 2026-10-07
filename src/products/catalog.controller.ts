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
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Public } from '../common/decorators/public.decorator.js'
import { PublicCache } from '../common/http/public-cache.js'
import { CatalogService, type CatalogFacetsDto } from './catalog.service.js'
import { AvailabilityQueryDto } from './dto/availability.dto.js'
import { CatalogQueryDto, FacetsQueryDto } from './dto/catalog-query.dto.js'
import { FeaturedQueryDto, RelatedQueryDto } from './dto/limit-query.dto.js'
import type { AvailabilityDto } from './product-availability.js'
import type { Paginated, PublicProductDto } from './product.mapper.js'

/** Per client IP: 60 availability checks a minute (the cart asks on open and on focus). */
const AVAILABILITY_LIMIT = { default: { limit: 60, ttl: 60_000 } }

@Public()
@Controller('products')
export class CatalogController {
    constructor(private readonly catalog: CatalogService) {}

    @Get()
    @PublicCache(60)
    list(@Query() query: CatalogQueryDto): Promise<Paginated<PublicProductDto>> {
        return this.catalog.list(query)
    }

    /** Filter values with their product counts, and the price range (declared before ":slug"). */
    @Get('facets')
    @PublicCache(60)
    facets(@Query() query: FacetsQueryDto): Promise<CatalogFacetsDto> {
        return this.catalog.facets(query.category)
    }

    // Declared before ":slug" so "featured" is not treated as a slug.
    @Get('featured')
    @PublicCache(60)
    featured(@Query() query: FeaturedQueryDto): Promise<PublicProductDto[]> {
        return this.catalog.featured(query.limit)
    }

    /**
     * Live stock of the cart lines, in request order (a POST so up to 50 lines fit in the body).
     * Never cached: the answer changes with every order.
     */
    @Post('availability')
    @HttpCode(HttpStatus.OK)
    @Throttle(AVAILABILITY_LIMIT)
    @Header('Cache-Control', 'no-store')
    async availability(@Body() dto: AvailabilityQueryDto): Promise<{ items: AvailabilityDto[] }> {
        return { items: await this.catalog.availability(dto.items) }
    }

    @Get(':slug')
    @PublicCache(60)
    bySlug(@Param('slug') slug: string): Promise<PublicProductDto> {
        return this.catalog.bySlug(slug)
    }

    @Get(':slug/related')
    related(
        @Param('slug') slug: string,
        @Query() query: RelatedQueryDto,
    ): Promise<PublicProductDto[]> {
        return this.catalog.related(slug, query.limit)
    }
}
