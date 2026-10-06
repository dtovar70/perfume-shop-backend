import type { INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module.js'
import { User } from '../src/auth/entities/user.entity.js'
import { Role } from '../src/auth/role.enum.js'
import { Bank } from '../src/catalogs/entities/bank.entity.js'
import { MobilePrefix } from '../src/catalogs/entities/mobile-prefix.entity.js'
import { OrderStatusDefinition } from '../src/catalogs/entities/order-status-definition.entity.js'
import { createValidationPipe } from '../src/common/pipes/validation.pipe.js'
import { catalogRows } from './fixtures/catalogs.js'

type Row = Record<string, unknown>

const USERS = {
    admin: { id: 'admin-1', role: Role.ADMIN },
    editor: { id: 'editor-1', role: Role.EDITOR },
}

function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value)
}

/**
 * In-memory catalogs (seeded like the migration) with the few writes the catalog services make.
 * `paymentsByBank` and `paymentContentBank` answer the "is this bank in use" queries.
 */
class CatalogDb {
    tables = new Map<unknown, Row[]>()
    paymentsByBank = new Map<string, number>()
    paymentContentBank: string | null = null
    /** Orders in progress per mobile operator code, and the stored content sections. */
    activeOrdersByPrefix = new Map<string, number>()
    contentRows: { key: string; value: Row }[] = []

    constructor(private readonly dropStatus?: string) {}

    table(entity: unknown): Row[] {
        let rows = this.tables.get(entity)
        if (!rows) {
            rows = (catalogRows(entity) ?? []) as Row[]
            if (entity === OrderStatusDefinition && this.dropStatus) {
                rows = rows.filter((row) => row.code !== this.dropStatus)
            }
            this.tables.set(entity, rows)
        }
        return rows
    }

    private update(entity: unknown, where: Row, changes: Row) {
        for (const row of this.table(entity).filter((candidate) => matches(candidate, where))) {
            Object.assign(row, changes)
        }
        return Promise.resolve({ affected: 1 })
    }

    private query(sql: string, params: unknown[] = []) {
        if (sql.includes('WITH "phones"')) {
            return Promise.resolve(
                [...this.activeOrdersByPrefix].map(([code, count]) => ({
                    code,
                    count: String(count),
                })),
            )
        }
        if (sql.includes('FROM "order_payments"')) {
            return Promise.resolve(
                [...this.paymentsByBank]
                    .filter(([code]) => !params.length || code === params[0])
                    .map(([code, count]) => ({ code, count: String(count) })),
            )
        }
        if (sql.includes('SELECT "key", "value" FROM "site_content"')) {
            return Promise.resolve(this.contentRows)
        }
        if (sql.includes('FROM "site_content"')) {
            return Promise.resolve(
                this.paymentContentBank ? [{ code: this.paymentContentBank }] : [],
            )
        }
        throw new Error(`Unexpected SQL: ${sql}`)
    }

    readonly manager = {
        find: (entity: unknown) => Promise.resolve(this.table(entity)),
        update: (entity: unknown, where: Row, changes: Row) => this.update(entity, where, changes),
    }

    repository(entity: unknown) {
        if (entity === User) {
            return {
                findOneBy: ({ id }: { id: string }) => {
                    const user = Object.values(USERS).find((candidate) => candidate.id === id)
                    return Promise.resolve(
                        user
                            ? {
                                  ...user,
                                  email: `${user.id}@example.com`,
                                  name: 'Staff',
                                  isActive: true,
                                  passwordChangedAt: null,
                                  createdAt: new Date(),
                                  updatedAt: new Date(),
                              }
                            : null,
                    )
                },
            }
        }
        const rows = () => this.table(entity)
        return {
            manager: {
                transaction: <T>(work: (manager: CatalogDb['manager']) => Promise<T>) =>
                    work(this.manager),
            },
            find: (options: { where?: Row } = {}) =>
                Promise.resolve(rows().filter((row) => matches(row, options.where))),
            findOne: (options: { where?: Row } = {}) =>
                Promise.resolve(rows().find((row) => matches(row, options.where)) ?? null),
            findOneBy: (where: Row) =>
                Promise.resolve(rows().find((row) => matches(row, where)) ?? null),
            existsBy: (where: Row) => Promise.resolve(rows().some((row) => matches(row, where))),
            update: (where: Row, changes: Row) => this.update(entity, where, changes),
            insert: (row: Row) => {
                rows().push({ ...row })
                return Promise.resolve({})
            },
            delete: (where: Row) => {
                const table = rows()
                const index = table.findIndex((row) => matches(row, where))
                if (index >= 0) table.splice(index, 1)
                return Promise.resolve({ affected: index >= 0 ? 1 : 0 })
            },
            query: (sql: string, params?: unknown[]) => this.query(sql, params),
            createQueryBuilder: () => {
                const builder = {
                    select: () => builder,
                    getRawOne: () =>
                        Promise.resolve({
                            max: Math.max(...rows().map((row) => row.sortOrder as number)),
                        }),
                }
                return builder
            },
        }
    }

    readonly dataSource = {
        isInitialized: false,
        entityMetadatas: [],
        options: { type: 'postgres' },
        manager: this.manager,
        getRepository: (entity: unknown) => this.repository(entity),
    }
}

async function createApp(db: CatalogDb): Promise<INestApplication> {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(getDataSourceToken())
        .useValue(db.dataSource)
        .compile()
    const app = moduleFixture.createNestApplication()
    app.setGlobalPrefix('api')
    app.use(cookieParser())
    app.useGlobalPipes(createValidationPipe())
    await app.init()
    return app
}

describe('Catalogs (e2e)', () => {
    let app: INestApplication
    let db: CatalogDb
    let cookie: (user: keyof typeof USERS) => string

    beforeEach(async () => {
        db = new CatalogDb()
        app = await createApp(db)
        const signer = new JwtService({ secret: app.get(ConfigService).get<string>('JWT_SECRET') })
        cookie = (user) =>
            `kz_session=${signer.sign({ sub: USERS[user].id, role: USERS[user].role }, { expiresIn: 600 })}`
    })

    afterEach(async () => {
        await app.close()
    })

    it('refuses to start when the status catalog does not match the code', async () => {
        await app.close()
        await expect(createApp(new CatalogDb('EXPIRADO'))).rejects.toThrow(
            /missing in order_statuses: EXPIRADO/,
        )
        app = await createApp(new CatalogDb())
    })

    it('GET /api/catalogs/order-statuses is public, sorted and revalidated with an ETag', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/catalogs/order-statuses')
            .expect(200)
            .expect('Cache-Control', 'no-cache')
        expect(response.headers.etag).toBeTruthy()

        const body = response.body as {
            groups: { code: string; statuses: string[]; highlight: boolean }[]
            statuses: { code: string; label: string }[]
        }
        expect(body.groups.map((group) => group.code)).toEqual([
            'POR_VERIFICAR',
            'POR_PAGAR',
            'EN_CURSO',
            'CERRADOS',
        ])
        expect(body.groups[0]).toMatchObject({
            highlight: true,
            statuses: ['PENDIENTE_VERIFICACION'],
        })
        expect(body.groups[1]?.statuses).toEqual(['PENDIENTE_PAGO', 'PAGO_RECHAZADO'])
        expect(body.statuses).toHaveLength(10)
        expect(body.statuses[1]).toMatchObject({
            code: 'PENDIENTE_VERIFICACION',
            label: 'Pendiente por verificación',
        })

        await request(app.getHttpServer())
            .get('/api/catalogs/order-statuses')
            .set('If-None-Match', response.headers.etag as string)
            .expect(304)
    })

    it('GET /api/catalogs/banks lists only the active banks', async () => {
        const response = await request(app.getHttpServer()).get('/api/catalogs/banks').expect(200)
        expect(response.body).toEqual([
            { code: '0102', name: 'Banco de Venezuela' },
            { code: '0134', name: 'Banesco' },
        ])
    })

    it('lets an ADMIN rename a status and serves the new label right away', async () => {
        await request(app.getHttpServer()).get('/api/catalogs/order-statuses').expect(200)

        await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/PENDIENTE_VERIFICACION')
            .send({ label: 'Por revisar' })
            .expect(401)
        await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/PENDIENTE_VERIFICACION')
            .set('Cookie', cookie('editor'))
            .send({ label: 'Por revisar' })
            .expect(403)

        const saved = await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/PENDIENTE_VERIFICACION')
            .set('Cookie', cookie('admin'))
            .send({
                label: '  Por revisar  ',
                customerLabel: 'Pago recibido',
                customerDescription: 'Lo revisamos en {marca}.',
                tone: 'lilac',
            })
            .expect(200)
        expect(
            (saved.body as { statuses: Row[] }).statuses.find(
                (status) => status.code === 'PENDIENTE_VERIFICACION',
            ),
        ).toMatchObject({
            label: 'Por revisar',
            customerLabel: 'Pago recibido',
            customerDescription: 'Lo revisamos en {marca}.',
            tone: 'lilac',
        })

        const catalog = await request(app.getHttpServer())
            .get('/api/catalogs/order-statuses')
            .expect(200)
        expect((catalog.body as { statuses: Row[] }).statuses[1]?.label).toBe('Por revisar')
    })

    it('never lets the code, the group or isTerminal be edited (400)', async () => {
        for (const body of [
            { code: 'OTRO' },
            { groupCode: 'CERRADOS' },
            { isTerminal: true },
            { label: 'Ok', sortOrder: 3 },
        ]) {
            const response = await request(app.getHttpServer())
                .patch('/api/admin/catalogs/order-statuses/ENVIADO')
                .set('Cookie', cookie('admin'))
                .send(body)
                .expect(400)
            const field = Object.keys(body).at(-1)
            expect(response.body.details).toEqual([
                { field, errors: [`El campo "${field}" no está permitido.`] },
            ])
        }

        const invalid = await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/ENVIADO')
            .set('Cookie', cookie('admin'))
            .send({ label: ' ', tone: 'red', customerDescription: 'Hola {nombre}' })
            .expect(400)
        expect(invalid.body.details).toEqual([
            { field: 'label', errors: ['El nombre del estado es obligatorio.'] },
            {
                field: 'customerDescription',
                errors: [
                    'El mensaje al cliente solo admite los marcadores {produccion} y {marca}.',
                ],
            },
            { field: 'tone', errors: ['El color no es válido.'] },
        ])

        await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/NO_EXISTE')
            .set('Cookie', cookie('admin'))
            .send({ label: 'X' })
            .expect(404)
        expect(db.table(OrderStatusDefinition).find((row) => row.code === 'ENVIADO')).toMatchObject(
            { label: 'Enviado', groupCode: 'EN_CURSO' },
        )
    })

    it('edits a tab: label, description and position, never its code', async () => {
        const saved = await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/groups/CERRADOS')
            .set('Cookie', cookie('admin'))
            .send({ label: 'Archivados', description: '', sortOrder: 0 })
            .expect(200)
        const groups = (saved.body as { groups: Row[] }).groups
        expect(groups[0]).toMatchObject({
            code: 'CERRADOS',
            label: 'Archivados',
            description: null,
        })

        await request(app.getHttpServer())
            .patch('/api/admin/catalogs/order-statuses/groups/CERRADOS')
            .set('Cookie', cookie('admin'))
            .send({ code: 'ARCHIVO' })
            .expect(400)
    })

    it('manages the banks: add, rename, deactivate, reorder; deletes only unused ones', async () => {
        const admin = (method: 'post' | 'patch' | 'delete', path: string) =>
            request(app.getHttpServer())
                [method](`/api/admin/catalogs/banks${path}`)
                .set('Cookie', cookie('admin'))

        const created = await admin('post', '').send({ code: '0199', name: ' Banco Nuevo ' })
        expect(created.status).toBe(201)
        expect(created.body).toMatchObject({
            code: '0199',
            name: 'Banco Nuevo',
            isActive: true,
            sortOrder: 3,
        })
        await admin('post', '').send({ code: '0102', name: 'Duplicado' }).expect(409)
        const badCode = await admin('post', '').send({ code: '12', name: 'X' }).expect(400)
        expect(badCode.body.details).toEqual([
            {
                field: 'code',
                errors: ['El código del banco debe tener el formato 0102 (4 dígitos).'],
            },
        ])

        await admin('patch', '/0134').send({ code: '0135' }).expect(400)
        const renamed = await admin('patch', '/0134')
            .send({ name: 'Banesco Banco Universal', isActive: false })
            .expect(200)
        expect(renamed.body).toMatchObject({ name: 'Banesco Banco Universal', isActive: false })
        const publicList = await request(app.getHttpServer()).get('/api/catalogs/banks')
        expect(publicList.body).toEqual([
            { code: '0102', name: 'Banco de Venezuela' },
            { code: '0199', name: 'Banco Nuevo' },
        ])

        const reordered = await admin('patch', '/order')
            .send({ codes: ['0199', '0134', '0104', '0102'] })
            .expect(200)
        expect((reordered.body as Row[]).map((bank) => bank.code)).toEqual([
            '0199',
            '0134',
            '0104',
            '0102',
        ])
        await admin('patch', '/order')
            .send({ codes: ['0199'] })
            .expect(400)

        db.paymentsByBank.set('0102', 2)
        db.paymentContentBank = '0102'
        const inUse = await admin('delete', '/0102').expect(409)
        expect(inUse.body.message).toBe(
            'No puedes eliminar este banco porque lo usan 2 pagos registrados y es el banco de tus datos de Pago Móvil. Desactívalo para ocultarlo.',
        )
        await admin('delete', '/0199').expect(204)
        expect(db.table(Bank).map((bank) => bank.code)).toEqual(['0102', '0104', '0134'])

        await request(app.getHttpServer())
            .get('/api/admin/catalogs/banks')
            .set('Cookie', cookie('editor'))
            .expect(403)
    })

    it('GET /api/catalogs/mobile-prefixes lists the active codes in order, with an ETag', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/catalogs/mobile-prefixes')
            .expect(200)
            .expect('Cache-Control', 'no-cache')
        expect(response.headers.etag).toBeTruthy()
        // 0426 is seeded inactive.
        expect(response.body).toEqual(
            ['0412', '0414', '0416', '0422', '0424'].map((code) => ({ code })),
        )
    })

    it('manages the mobile codes: add, deactivate, reorder; deletes only unused ones', async () => {
        const admin = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
            request(app.getHttpServer())
                [method](`/api/admin/catalogs/mobile-prefixes${path}`)
                .set('Cookie', cookie('admin'))
        const publicCodes = async () =>
            (
                (await request(app.getHttpServer()).get('/api/catalogs/mobile-prefixes'))
                    .body as Row[]
            ).map((row) => row.code)

        await request(app.getHttpServer()).get('/api/admin/catalogs/mobile-prefixes').expect(401)
        await request(app.getHttpServer())
            .post('/api/admin/catalogs/mobile-prefixes')
            .set('Cookie', cookie('editor'))
            .send({ code: '0418' })
            .expect(403)

        db.activeOrdersByPrefix.set('0412', 2)
        db.contentRows = [{ key: 'payment', value: { phone: '0424-1234567' } }]
        const list = await admin('get', '').expect(200).expect('Cache-Control', 'no-store')
        expect(list.body[0]).toEqual({
            code: '0412',
            isActive: true,
            sortOrder: 0,
            activeOrderCount: 2,
            contentFields: [],
        })
        // Nothing stored for "contact": its default WhatsApp (0414-…) counts.
        expect((list.body as Row[]).find((row) => row.code === '0414')).toMatchObject({
            contentFields: ['contact.whatsapp'],
        })
        expect((list.body as Row[]).find((row) => row.code === '0424')).toMatchObject({
            contentFields: ['payment.phone'],
        })

        const created = await admin('post', '').send({ code: ' 0418 ', isActive: false })
        expect(created.status).toBe(201)
        expect(created.body).toMatchObject({ code: '0418', isActive: false, sortOrder: 6 })
        await admin('post', '').send({ code: '0412' }).expect(409)
        for (const code of ['0212', '412', '04a1']) {
            const bad = await admin('post', '').send({ code }).expect(400)
            expect(bad.body.details).toEqual([
                {
                    field: 'code',
                    errors: [
                        'El código de celular debe tener el formato 0424 (4 dígitos que empiezan por 04).',
                    ],
                },
            ])
        }

        await admin('patch', '/0416').send({ isActive: false }).expect(200)
        await admin('patch', '/0426').send({ isActive: true }).expect(200)
        await admin('patch', '/0416').send({ code: '0417', isActive: true }).expect(400)
        await admin('patch', '/0499').send({ isActive: true }).expect(404)
        expect(await publicCodes()).toEqual(['0412', '0414', '0422', '0424', '0426'])

        const reordered = await admin('patch', '/order')
            .send({ codes: ['0424', '0412', '0414', '0416', '0422', '0426', '0418'] })
            .expect(200)
        expect((reordered.body as Row[]).map((row) => row.code)).toEqual([
            '0424',
            '0412',
            '0414',
            '0416',
            '0422',
            '0426',
            '0418',
        ])
        expect(await publicCodes()).toEqual(['0424', '0412', '0414', '0422', '0426'])
        await admin('patch', '/order')
            .send({ codes: ['0424'] })
            .expect(400)

        const inUse = await admin('delete', '/0412').expect(409)
        expect(inUse.body.message).toBe(
            'No puedes eliminar el código 0412 porque lo usan 2 pedidos en curso. Desactívalo para ocultarlo.',
        )
        await admin('delete', '/0424').expect(409)
        await admin('delete', '/0418').expect(204)
        await admin('delete', '/0418').expect(404)
        expect(db.table(MobilePrefix).map((row) => row.code)).not.toContain('0418')
    })
})
