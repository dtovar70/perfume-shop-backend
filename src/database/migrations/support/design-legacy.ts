/**
 * Frozen copy of the retired "Diseña con tu imagen" layer types, only as the DesignLayers
 * migration stored them in `designs.layers`. The feature was removed; the migration still runs.
 */
export type DesignFormat = 'jpg' | 'png' | 'webp'

interface LayerPlacement {
    x: number
    y: number
    scale: number
    rotation: number
}

export interface DesignImageLayer {
    type: 'image'
    z: number
    placement: LayerPlacement
    assetIndex: number
    format: DesignFormat
    width: number
    height: number
    bytes: number
    dpi: number
}

export interface DesignTextLayer {
    type: 'text'
    z: number
    placement: LayerPlacement
    content: string
    font: string
    color: string
    outline: string
    align: string
}

export type DesignLayer = DesignImageLayer | DesignTextLayer

/**
 * Mapping between the Stage 1 design row (one image, its original in `designs.original_*`)
 * and the layered one (`designs.layers` + `design_assets`). Pure, used by the DesignLayers
 * migration in both directions.
 */

/** The Stage 1 columns of a design. */
export interface LegacyDesignRow {
    id: string
    original_key: string
    original_format: string
    original_width: number
    original_height: number
    original_bytes: number
    /** `{ x, y, scale, rotation, printWidthCm, printHeightCm }`. */
    placement: Record<string, unknown>
    dpi_estimate: number
}

export interface LegacyAssetRow {
    design_id: string
    kind: 'original'
    layer_index: number
    storage_key: string
    format: DesignFormat
    width: number
    height: number
    bytes: number
}

export interface LayeredDesign {
    layers: DesignLayer[]
    printSize: { widthCm: number; heightCm: number }
    dpiEstimate: number
    asset: LegacyAssetRow
}

const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

function format(value: string): DesignFormat {
    return value === 'png' || value === 'webp' ? value : 'jpg'
}

/** Stage 1 → layered: one image layer (asset 0) and its 'original' asset row. */
export function legacyToLayered(row: LegacyDesignRow): LayeredDesign {
    const placement = row.placement ?? {}
    const layer: DesignImageLayer = {
        type: 'image',
        z: 0,
        placement: {
            x: num(placement.x, 0),
            y: num(placement.y, 0),
            scale: num(placement.scale, 1),
            rotation: num(placement.rotation, 0),
        },
        assetIndex: 0,
        format: format(row.original_format),
        width: row.original_width,
        height: row.original_height,
        bytes: row.original_bytes,
        dpi: row.dpi_estimate,
    }
    return {
        layers: [layer],
        printSize: {
            widthCm: num(placement.printWidthCm, 0),
            heightCm: num(placement.printHeightCm, 0),
        },
        dpiEstimate: row.dpi_estimate,
        asset: {
            design_id: row.id,
            kind: 'original',
            layer_index: 0,
            storage_key: row.original_key,
            format: layer.format,
            width: row.original_width,
            height: row.original_height,
            bytes: row.original_bytes,
        },
    }
}

/** A `design_assets` row as read back by `down()`. */
export interface LayeredAssetRow {
    kind: string
    layer_index: number | null
    storage_key: string
    format: string
    width: number
    height: number
    bytes: number
}

/** The Stage 1 columns rebuilt from a layered design (without `id`). */
export type LegacyColumns = Omit<LegacyDesignRow, 'id'>

/**
 * Layered → Stage 1, for `down()`: the bottom image layer becomes the single image, with its
 * original and placement. A design without images (text only) falls back to its arte final,
 * centered over the whole area, at 200 DPI. Null when there is no file to keep at all.
 */
export function layeredToLegacy(
    layers: readonly DesignLayer[],
    printSize: { widthCm: number; heightCm: number },
    assets: readonly LayeredAssetRow[],
): LegacyColumns | null {
    const area = { printWidthCm: printSize.widthCm, printHeightCm: printSize.heightCm }
    for (const [index, layer] of layers.entries()) {
        if (layer.type !== 'image') continue
        const asset = assets.find(
            (candidate) => candidate.kind === 'original' && candidate.layer_index === index,
        )
        if (!asset) continue
        return {
            original_key: asset.storage_key,
            original_format: asset.format,
            original_width: asset.width,
            original_height: asset.height,
            original_bytes: asset.bytes,
            placement: { ...layer.placement, ...area },
            dpi_estimate: layer.dpi,
        }
    }
    const artwork = assets.find((candidate) => candidate.kind === 'artwork')
    if (!artwork) return null
    return {
        original_key: artwork.storage_key,
        original_format: 'png',
        original_width: artwork.width,
        original_height: artwork.height,
        original_bytes: artwork.bytes,
        placement: { x: 0, y: 0, scale: 1, rotation: 0, ...area },
        dpi_estimate: 200,
    }
}
