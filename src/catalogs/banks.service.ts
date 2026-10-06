import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { isDbError, omitUndefined } from '../database/db-errors.js'
import type { CreateBankDto } from './dto/create-bank.dto.js'
import type { UpdateBankDto } from './dto/update-bank.dto.js'
import { Bank } from './entities/bank.entity.js'

export const BANK_NOT_FOUND = 'No encontramos ese banco.'
export const BANK_ORDER_MISMATCH =
    'La lista debe incluir exactamente todos los bancos, cada uno una sola vez.'
/** Sub-route of `admin/catalogs/banks` used to reorder ("order" is never a four-digit code). */
export const BANK_ORDER_ROUTE = 'order'

/** Matches `Bank` in frontend-perfume-shop/src/@types/catalog.ts. */
export interface BankDto {
    code: string
    name: string
}

/** Matches `AdminBank` in frontend-perfume-shop/src/@types/catalog.ts. */
export interface AdminBankDto extends BankDto {
    isActive: boolean
    sortOrder: number
    /** Payment proofs that name this bank. */
    paymentCount: number
    /** The Pago Móvil details of the store use this bank. */
    usedByPaymentContent: boolean
}

interface BankUsage {
    paymentCount: number
    usedByPaymentContent: boolean
}

function codeTakenMessage(code: string): string {
    return `Ya existe un banco con el código ${code}.`
}

/** Why a bank cannot be deleted, or null when nothing uses it. */
export function bankInUseMessage(usage: BankUsage): string | null {
    const reasons = [
        usage.paymentCount === 1
            ? 'lo usa 1 pago registrado'
            : usage.paymentCount > 1
              ? `lo usan ${usage.paymentCount} pagos registrados`
              : '',
        usage.usedByPaymentContent ? 'es el banco de tus datos de Pago Móvil' : '',
    ].filter(Boolean)
    if (!reasons.length) return null
    return `No puedes eliminar este banco porque ${reasons.join(' y ')}. Desactívalo para ocultarlo.`
}

function byOrder(a: Bank, b: Bank): number {
    return a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)
}

/** The Venezuelan banks catalog (`banks`): public list, admin CRUD and payment validation. */
@Injectable()
export class BanksService {
    constructor(@InjectRepository(Bank) private readonly banks: Repository<Bank>) {}

    /** Active banks, in select order. */
    async listActive(): Promise<BankDto[]> {
        const rows = await this.banks.find({ where: { isActive: true } })
        return rows.sort(byOrder).map((row) => ({ code: row.code, name: row.name }))
    }

    /** Every bank, inactive ones included, with what references it. */
    async listForAdmin(): Promise<AdminBankDto[]> {
        const [rows, usage] = await Promise.all([this.banks.find(), this.usage()])
        return rows.sort(byOrder).map((row) => toAdminDto(row, usage(row.code)))
    }

    /**
     * The active bank with this code, or null. Payments and the Pago Móvil content only accept
     * active banks.
     */
    async findActive(code: string): Promise<Bank | null> {
        const bank = await this.banks.findOne({ where: { code } })
        return bank?.isActive ? bank : null
    }

    async create(dto: CreateBankDto): Promise<AdminBankDto> {
        if (await this.banks.existsBy({ code: dto.code })) {
            throw new ConflictException(codeTakenMessage(dto.code))
        }
        const bank: Bank = {
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive ?? true,
            sortOrder: await this.nextSortOrder(),
        }
        try {
            await this.banks.insert(bank)
        } catch (error) {
            if (isDbError(error, '23505')) throw new ConflictException(codeTakenMessage(dto.code))
            throw error
        }
        return toAdminDto(bank, { paymentCount: 0, usedByPaymentContent: false })
    }

    async update(code: string, dto: UpdateBankDto): Promise<AdminBankDto> {
        const bank = await this.banks.findOneBy({ code })
        if (!bank) throw new NotFoundException(BANK_NOT_FOUND)

        const changes = omitUndefined({ name: dto.name, isActive: dto.isActive })
        if (!Object.keys(changes).length) {
            throw new BadRequestException('No enviaste ningún cambio.')
        }
        await this.banks.update({ code }, changes)
        const usage = await this.usage(code)
        return toAdminDto({ ...bank, ...changes }, usage(code))
    }

    /** Rewrites every position as 0..n-1 following `codes` (exactly the existing codes). */
    async reorder(codes: string[]): Promise<AdminBankDto[]> {
        await this.banks.manager.transaction(async (manager) => {
            const current = await manager.find(Bank, { select: { code: true } })
            const currentCodes = new Set(current.map((bank) => bank.code))
            const sameSet =
                currentCodes.size === codes.length &&
                new Set(codes).size === codes.length &&
                codes.every((code) => currentCodes.has(code))
            if (!sameSet) throw new BadRequestException(BANK_ORDER_MISMATCH)

            for (const [index, code] of codes.entries()) {
                await manager.update(Bank, { code }, { sortOrder: index })
            }
        })
        return this.listForAdmin()
    }

    /**
     * Only banks nothing refers to can be deleted; the others are deactivated instead. The
     * `order_payments.payer_bank_code` foreign key (`ON DELETE RESTRICT`) is the safety net.
     */
    async remove(code: string): Promise<void> {
        if (!(await this.banks.existsBy({ code }))) throw new NotFoundException(BANK_NOT_FOUND)
        await this.assertUnused(code)
        try {
            await this.banks.delete({ code })
        } catch (error) {
            // A payment named the bank between the check and the delete.
            if (isDbError(error, '23503')) await this.assertUnused(code)
            throw error
        }
    }

    private async assertUnused(code: string): Promise<void> {
        const usage = await this.usage(code)
        const message = bankInUseMessage(usage(code))
        if (message) throw new ConflictException(message)
    }

    /** Payment proofs per bank code and the bank of the Pago Móvil content (one or all codes). */
    private async usage(code?: string): Promise<(code: string) => BankUsage> {
        const [payments, content] = await Promise.all([
            this.banks.query<{ code: string; count: string }[]>(
                `SELECT "payer_bank_code" AS "code", COUNT(*) AS "count" FROM "order_payments"
                 ${code ? 'WHERE "payer_bank_code" = $1' : ''}
                 GROUP BY "payer_bank_code"`,
                code ? [code] : [],
            ),
            this.banks.query<{ code: string | null }[]>(
                `SELECT "value"->>'bankCode' AS "code" FROM "site_content" WHERE "key" = 'payment'`,
            ),
        ])
        const counts = new Map(payments.map((row) => [row.code, Number(row.count)]))
        const contentCode = content[0]?.code ?? null
        return (bankCode) => ({
            paymentCount: counts.get(bankCode) ?? 0,
            usedByPaymentContent: contentCode === bankCode,
        })
    }

    private async nextSortOrder(): Promise<number> {
        const row = await this.banks
            .createQueryBuilder('bank')
            .select('MAX(bank.sortOrder)', 'max')
            .getRawOne<{ max: number | null }>()
        return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1
    }
}

function toAdminDto(bank: Bank, usage: BankUsage): AdminBankDto {
    return {
        code: bank.code,
        name: bank.name,
        isActive: bank.isActive,
        sortOrder: bank.sortOrder,
        ...usage,
    }
}
