import { OmitType, PartialType } from '@nestjs/mapped-types'
import { CreateBrandDto } from './create-brand.dto.js'

/** Every field is optional; the slug is the brand's identity and cannot be changed. */
export class UpdateBrandDto extends PartialType(OmitType(CreateBrandDto, ['slug'] as const)) {}
