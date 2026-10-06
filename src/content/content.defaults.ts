/**
 * Built-in content: exactly the texts and values the storefront shipped with before they became
 * editable. `GET /content` merges the stored values over these, so a section nobody edited (or a
 * field added later) renders these.
 *
 * Mirrored in the storefront's src/configs/content.defaults.ts, which the storefront uses when the
 * API cannot be reached. Keep both files identical (only the import and this comment differ).
 */
import type { SiteContent } from './content.types.js'

export const DEFAULT_SITE_CONTENT: SiteContent = {
    general: {
        brandName: 'KaiZen',
        tagline: 'Perfumería de autor',
        description:
            'Perfumes originales árabes, de nicho y de diseñador. Fragancias seleccionadas una a una, con envío a toda Venezuela.',
        titleSuffix: 'Perfumería de autor',
        metaDescription:
            'Perfumes originales árabes, de nicho y de diseñador en Venezuela. Precios en dólares, pago móvil en bolívares a tasa BCV y envío gratis desde {envioGratis}.',
        searchPlaceholder: 'Buscar perfumes, marcas, notas…',
    },
    announcements: {
        messages: [
            'Envío gratis desde {envioGratis}',
            'Perfumes 100% originales',
            'Paga con Pago Móvil a tasa BCV',
        ],
    },
    home: {
        heroBadge: '',
        heroTitle: 'Fragancias que *cuentan* quién eres',
        heroSubtitle:
            'Una selección cuidada de perfumes árabes, de nicho y de diseñador. Encuentra tu firma olfativa y llévala contigo.',
        heroPrimaryCta: 'Explorar catálogo',
        heroSecondaryCta: 'Ver los más vendidos',
        heroFeatures: ['100% originales', 'Envío nacional', 'Asesoría olfativa'],
        heroMedia: null,
        categoriesEyebrow: 'Colecciones',
        categoriesTitle: 'Encuentra tu *esencia*',
        categoriesDescription:
            '{categorias}: fragancias para cada estilo, cada ocasión y cada momento del día.',
        featuredEyebrow: 'Los más deseados',
        featuredTitle: 'Nuestros *favoritos*',
        featuredDescription: 'Las fragancias que más enamoran a nuestros clientes esta temporada.',
        featuredCta: 'Ver todo el catálogo',
        stepsEyebrow: 'Así de fácil',
        stepsTitle: '*Tres pasos* y listo',
        stepsDescription: 'Comprar tu próximo perfume nunca fue tan sencillo.',
        steps: [
            {
                title: 'Elige tu fragancia',
                description:
                    'Filtra por marca, familia olfativa o notas y descubre el aroma que va contigo.',
            },
            {
                title: 'Paga con Pago Móvil',
                description:
                    'Ves el precio en dólares y pagas en bolívares a la tasa BCV del día, sin complicaciones.',
            },
            {
                title: 'Recíbelo en tu puerta',
                description:
                    'Lo empacamos con cuidado y te lo enviamos a cualquier ciudad del país.',
            },
        ],
        testimonialsEyebrow: 'Clientes felices',
        testimonialsTitle: 'Lo que *dicen* de nosotros',
        testimonials: [],
        ctaBadge: 'Asesoría experta',
        ctaTitle: '¿No sabes cuál *elegir*?',
        ctaDescription:
            'Cuéntanos qué aromas te gustan y te recomendamos la fragancia ideal para ti o para regalar.',
        ctaPrimary: 'Pedir asesoría',
        ctaSecondary: 'Conócenos',
    },
    about: {
        badge: 'Desde 2024',
        title: 'Una perfumería con *alma*',
        paragraphs: [
            '{marca} nació de una pasión: compartir fragancias que despiertan emociones. Seleccionamos cada perfume con calma y criterio, como dicta la filosofía que nos da nombre: mejorar un poco cada día.',
            'Atendemos desde {ciudad} y enviamos a todo el país. Solo trabajamos con perfumes originales y te acompañamos hasta que encuentres el aroma que de verdad te representa.',
        ],
        ctaLabel: 'Hablemos de perfumes',
        imageBadge: 'Originales garantizados',
        valuesEyebrow: 'Cómo trabajamos',
        valuesTitle: 'Lo que *no negociamos*',
        valuesDescription: 'Cuatro principios detrás de cada frasco que enviamos.',
        values: [
            {
                icon: 'shield-check',
                title: 'Autenticidad',
                description:
                    'Solo vendemos perfumes originales, sellados y de proveedores de confianza.',
            },
            {
                icon: 'heart-handshake',
                title: 'Trato cercano',
                description:
                    'Te asesoramos como amigos: sin presión, con honestidad y conociendo cada fragancia.',
            },
            {
                icon: 'truck',
                title: 'Envíos seguros',
                description:
                    'Empacamos cada pedido con protección extra para que llegue perfecto a tus manos.',
            },
            {
                icon: 'sparkles',
                title: 'Selección curada',
                description:
                    'Probamos cada fragancia antes de sumarla al catálogo. Si no nos enamora, no entra.',
            },
        ],
        statsEyebrow: 'En números',
        statsTitle: 'KaiZen en *cifras*',
        stats: [
            { value: '+1.500', label: 'clientes felices' },
            { value: '+120', label: 'fragancias' },
            { value: '23', label: 'ciudades atendidas' },
        ],
    },
    contact: {
        email: 'hola@kaizen.com',
        phone: '0414-5086536',
        whatsapp: '0414-5086536',
        city: 'Caracas',
        schedule: 'Lunes a sábado, 9:00 a.m. – 7:00 p.m.',
        instagram: 'kaizen.perfumeria',
        tiktok: 'kaizen.perfumeria',
    },
    contactPage: {
        badge: 'Respondemos rápido',
        title: 'Cuéntanos qué *aroma* buscas',
        intro: 'Un regalo especial, tu perfume de diario o una fragancia para una ocasión única. Escríbenos y te ayudamos a elegir.',
        faqEyebrow: 'Dudas comunes',
        faqTitle: 'Preguntas *frecuentes*',
        faq: [
            {
                question: '¿Los perfumes son originales?',
                answer: 'Sí. Todos nuestros perfumes son 100% originales y llegan sellados de fábrica.',
            },
            {
                question: '¿Cómo pago mi pedido?',
                answer: 'Por Pago Móvil en bolívares, a la tasa oficial del BCV del día. Al confirmar tu pedido te mostramos el monto exacto.',
            },
            {
                question: '¿Cuánto tarda en llegar?',
                answer: '{produccion}, contados desde que verificamos tu pago. El tiempo de entrega depende de tu ciudad.',
            },
            {
                question: '¿Cómo funciona el envío?',
                answer: 'Envío gratis desde {envioGratis}. Por debajo de ese monto cobramos una tarifa plana y te enviamos el número de guía apenas sale el paquete.',
            },
        ],
    },
    shipping: {
        freeThreshold: 60,
        flatRate: 4,
        freeShippingCopy: 'Envío gratis desde {envioGratis}',
        productionCopy: 'Despacho en 24 a 48 horas hábiles',
    },
    /** Not shown on the storefront yet (checkout will use it); empty until the owner fills it. */
    payment: {
        bankCode: '',
        bankName: '',
        phone: '',
        idNumber: '',
        holderName: '',
        instructions: '',
    },
}
