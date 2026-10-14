import type { ContentSection } from '../content.types.js'
import { AboutContentDto } from './about.dto.js'
import { ContactPageContentDto } from './contact-page.dto.js'
import { ContactContentDto } from './contact.dto.js'
import { GeneralContentDto } from './general.dto.js'
import { HomeContentDto } from './home.dto.js'
import { PaymentContentDto } from './payment.dto.js'
import { ShippingContentDto } from './shipping.dto.js'

/** The DTO that validates each section on `PUT /admin/content/:section`. */
export const CONTENT_SECTION_DTOS = {
    general: GeneralContentDto,
    home: HomeContentDto,
    about: AboutContentDto,
    contact: ContactContentDto,
    contactPage: ContactPageContentDto,
    shipping: ShippingContentDto,
    payment: PaymentContentDto,
} as const satisfies Record<ContentSection, new () => object>
