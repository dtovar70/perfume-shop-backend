import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Put,
    UploadedFiles,
    UseFilters,
    UseInterceptors,
} from '@nestjs/common'
import { FileFieldsInterceptor } from '@nestjs/platform-express'
import { Role } from '../auth/role.enum.js'
import { InvalidatesCache } from '../cache/invalidates-cache.decorator.js'
import { CurrentUser } from '../common/decorators/current-user.decorator.js'
import { Public } from '../common/decorators/public.decorator.js'
import { Roles } from '../common/decorators/roles.decorator.js'
import { PublicCache } from '../common/http/public-cache.js'
import type { AuthUser } from '../common/types/auth-user.js'
import {
    ContentService,
    type AdminContentDto,
    type AdminContentSectionDto,
    type HeroMediaUploadDto,
} from './content.service.js'
import type { SiteContent } from './content.types.js'
import { HERO_MEDIA_FIELDS, HERO_MEDIA_UPLOAD } from './hero-media-upload.js'

/**
 * Public site content, the same for every visitor: browsers and CDNs may keep it a minute (and
 * serve it stale while refreshing), so an edit reaches the storefront within about a minute.
 * Express adds a weak ETag, so a revalidated, unchanged payload costs a 304.
 */
@Public()
@Controller('content')
export class ContentController {
    constructor(private readonly content: ContentService) {}

    @Get()
    @PublicCache(60)
    getAll(): Promise<SiteContent> {
        return this.content.getAll()
    }
}

@Roles(Role.ADMIN, Role.EDITOR)
@InvalidatesCache('content')
@Controller('admin/content')
export class AdminContentController {
    constructor(private readonly content: ContentService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    getAll(): Promise<AdminContentDto> {
        return this.content.getAllForAdmin()
    }

    /**
     * Uploads the home hero's image or video (`file`, plus an optional `poster` image) and
     * returns its URL. Saving the home section with that URL publishes it and deletes the
     * previous upload. Declared before `:section` routes for readability; paths do not overlap.
     */
    @Post('hero-media')
    @UseFilters(HERO_MEDIA_UPLOAD.filter)
    @UseInterceptors(FileFieldsInterceptor(HERO_MEDIA_FIELDS, HERO_MEDIA_UPLOAD.options))
    uploadHeroMedia(
        @UploadedFiles()
        files: { file?: Express.Multer.File[]; poster?: Express.Multer.File[] } | undefined,
    ): Promise<HeroMediaUploadDto> {
        return this.content.uploadHeroMedia(files?.file?.[0], files?.poster?.[0])
    }

    /**
     * Replaces the whole section. The body is validated by the section's DTO inside the
     * service (the DTO depends on `:section`); an unknown section is a 404.
     */
    @Put(':section')
    update(
        @Param('section') section: string,
        @Body() body: unknown,
        @CurrentUser() user: AuthUser,
    ): Promise<AdminContentSectionDto> {
        return this.content.update(section, body, user)
    }

    /** Restores the built-in texts of a section. */
    @Roles(Role.ADMIN)
    @Post(':section/reset')
    @HttpCode(HttpStatus.OK)
    reset(@Param('section') section: string): Promise<AdminContentSectionDto> {
        return this.content.reset(section)
    }
}
