import type { ContactContent } from '../content/content.types.js'
import { toWhatsAppPhone } from '../orders/whatsapp/whatsapp-template.js'

/**
 * A tiny email builder: the content is a list of blocks rendered twice, as table-based HTML with
 * inline CSS (what email clients understand) and as its plain-text alternative. Every value is
 * escaped here, so templates pass raw user data (names, notes, addresses).
 */

/** Plain text, a bold part, or a link. */
export type EmailInline = string | { bold: string } | { href: string; label: string }

export type EmailBlock =
    | { kind: 'heading'; text: string }
    | { kind: 'paragraph'; parts: EmailInline[] }
    /** Small grey text. */
    | { kind: 'note'; parts: EmailInline[] }
    | { kind: 'button'; href: string; label: string }
    /** Label/value pairs (payment data, totals). `strong` highlights a row (the amount to pay). */
    | { kind: 'rows'; title?: string; rows: { label: string; value: string; strong?: boolean }[] }
    /** Ordered lines: a title, detail lines below it and an amount on the right. */
    | { kind: 'items'; items: { title: string; details: EmailItemDetail[]; amount: string }[] }
    | { kind: 'divider' }

/** A detail line of an item; with `swatch` (`#RRGGBB`) a small color dot precedes it. */
export type EmailItemDetail = string | { text: string; swatch: string }

const SWATCH_PATTERN = /^#[0-9A-Fa-f]{6}$/

function detailText(detail: EmailItemDetail): string {
    return typeof detail === 'string' ? detail : detail.text
}

function detailHtml(detail: EmailItemDetail): string {
    const swatch =
        typeof detail !== 'string' && SWATCH_PATTERN.test(detail.swatch)
            ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${detail.swatch};border:1px solid ${COLOR.line};vertical-align:middle;margin-right:6px;"></span>`
            : ''
    return `${swatch}${escapeHtml(detailText(detail))}`
}

export interface EmailLayoutInput {
    brandName: string
    contact: ContactContent
    /** Preview line shown by inbox lists after the subject. */
    preheader: string
    blocks: EmailBlock[]
}

export interface RenderedEmail {
    html: string
    text: string
}

const COLOR = {
    ink: '#2e2438',
    inkSoft: '#6b5f78',
    line: '#f0e4ec',
    cream: '#fff9fb',
    blush: '#ffe7f1',
    button: '#c44a80',
    accent: '#e75f9b',
    white: '#ffffff',
}
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif"

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/** Only web and mail links become `href`s (never `javascript:` and the like). */
function safeHref(href: string): string {
    return /^(https?:|mailto:)/i.test(href) ? href : '#'
}

function inlineHtml(parts: EmailInline[]): string {
    return parts
        .map((part) => {
            if (typeof part === 'string') return escapeHtml(part)
            if ('bold' in part) return `<strong>${escapeHtml(part.bold)}</strong>`
            return `<a href="${escapeHtml(safeHref(part.href))}" style="color:${COLOR.button};text-decoration:underline;">${escapeHtml(part.label)}</a>`
        })
        .join('')
        .replace(/\n/g, '<br>')
}

function inlineText(parts: EmailInline[]): string {
    return parts
        .map((part) => {
            if (typeof part === 'string') return part
            if ('bold' in part) return part.bold
            return part.label === part.href ? part.href : `${part.label} (${part.href})`
        })
        .join('')
}

function blockHtml(block: EmailBlock): string {
    const cell = (content: string, style = '') =>
        `<tr><td style="padding:0 0 16px 0;${style}">${content}</td></tr>`
    switch (block.kind) {
        case 'heading':
            return cell(
                `<h1 style="margin:0;font-size:22px;line-height:1.3;color:${COLOR.ink};font-weight:700;">${escapeHtml(block.text)}</h1>`,
            )
        case 'paragraph':
            return cell(
                `<p style="margin:0;font-size:15px;line-height:1.6;color:${COLOR.ink};">${inlineHtml(block.parts)}</p>`,
            )
        case 'note':
            return cell(
                `<p style="margin:0;font-size:13px;line-height:1.5;color:${COLOR.inkSoft};">${inlineHtml(block.parts)}</p>`,
            )
        case 'button':
            return cell(
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="${COLOR.button}" style="border-radius:999px;"><a href="${escapeHtml(safeHref(block.href))}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:700;color:${COLOR.white};text-decoration:none;border-radius:999px;">${escapeHtml(block.label)}</a></td></tr></table>`,
                'text-align:center;padding-top:4px;padding-bottom:20px;',
            )
        case 'rows': {
            const title = block.title
                ? `<tr><td colspan="2" style="padding:0 0 8px 0;font-size:15px;font-weight:700;color:${COLOR.ink};">${escapeHtml(block.title)}</td></tr>`
                : ''
            const rows = block.rows
                .map((row) => {
                    const size = row.strong ? '17px' : '14px'
                    const weight = row.strong ? '700' : '400'
                    return `<tr><td valign="top" style="padding:6px 12px 6px 0;font-size:14px;color:${COLOR.inkSoft};">${escapeHtml(row.label)}</td><td valign="top" align="right" style="padding:6px 0;font-size:${size};font-weight:${weight};color:${COLOR.ink};word-break:break-word;">${escapeHtml(row.value)}</td></tr>`
                })
                .join('')
            return cell(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.cream};border:1px solid ${COLOR.line};border-radius:16px;padding:14px 16px;">${title}${rows}</table>`,
            )
        }
        case 'items': {
            const rows = block.items
                .map((item) => {
                    const details = item.details
                        .map(
                            (detail) =>
                                `<br><span style="font-size:13px;color:${COLOR.inkSoft};">${detailHtml(detail)}</span>`,
                        )
                        .join('')
                    return `<tr><td valign="top" style="padding:10px 12px 10px 0;border-bottom:1px solid ${COLOR.line};font-size:14px;color:${COLOR.ink};word-break:break-word;"><strong>${escapeHtml(item.title)}</strong>${details}</td><td valign="top" align="right" style="padding:10px 0;border-bottom:1px solid ${COLOR.line};font-size:14px;color:${COLOR.ink};white-space:nowrap;">${escapeHtml(item.amount)}</td></tr>`
                })
                .join('')
            return cell(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`,
            )
        }
        case 'divider':
            return cell(`<div style="border-top:1px solid ${COLOR.line};height:1px;"></div>`)
    }
}

function blockText(block: EmailBlock): string {
    switch (block.kind) {
        case 'heading':
            return block.text.toUpperCase()
        case 'paragraph':
        case 'note':
            return inlineText(block.parts)
        case 'button':
            return `${block.label}: ${block.href}`
        case 'rows': {
            const rows = block.rows.map((row) => `${row.label}: ${row.value}`)
            return (block.title ? [block.title, ...rows] : rows).join('\n')
        }
        case 'items':
            return block.items
                .map((item) =>
                    [
                        `- ${item.title} — ${item.amount}`,
                        ...item.details.map((d) => `  ${detailText(d)}`),
                    ].join('\n'),
                )
                .join('\n')
        case 'divider':
            return '---'
    }
}

interface ContactLink {
    label: string
    href: string
}

/** The footer's contact links (only the ones set in the content). */
export function contactLinks(contact: ContactContent): ContactLink[] {
    const links: ContactLink[] = []
    const email = contact.email.trim()
    if (email) links.push({ label: email, href: `mailto:${email}` })
    const whatsapp = toWhatsAppPhone(contact.whatsapp)
    if (whatsapp)
        links.push({
            label: `WhatsApp ${contact.whatsapp.trim()}`,
            href: `https://wa.me/${whatsapp}`,
        })
    const instagram = contact.instagram.trim().replace(/^@/, '')
    if (instagram) {
        links.push({
            label: `Instagram @${instagram}`,
            href: `https://instagram.com/${encodeURIComponent(instagram)}`,
        })
    }
    return links
}

/** The brand header, the blocks and a footer with the shop's contact data. */
export function renderEmail(input: EmailLayoutInput): RenderedEmail {
    const brand = escapeHtml(input.brandName)
    const links = contactLinks(input.contact)
    const footerLinks = links
        .map(
            (link) =>
                `<a href="${escapeHtml(link.href)}" style="color:${COLOR.inkSoft};text-decoration:underline;">${escapeHtml(link.label)}</a>`,
        )
        .join(' &nbsp;·&nbsp; ')
    const body = input.blocks.map(blockHtml).join('')

    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${brand}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR.blush};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.blush};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT};">
<tr><td align="center" style="padding:8px 0 20px 0;font-size:24px;font-weight:700;color:${COLOR.accent};letter-spacing:0.3px;">✨ ${brand}</td></tr>
<tr><td style="background:${COLOR.white};border-radius:24px;padding:28px 24px 12px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
</td></tr>
<tr><td align="center" style="padding:20px 12px 8px 12px;font-size:12px;line-height:1.6;color:${COLOR.inkSoft};">
<strong style="color:${COLOR.ink};">${brand}</strong>${footerLinks ? `<br>${footerLinks}` : ''}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`

    const footerText = [input.brandName, ...links.map((link) => `${link.label}: ${link.href}`)]
    const text = [...input.blocks.map(blockText), ['--', ...footerText].join('\n')].join('\n\n')
    return { html, text }
}
