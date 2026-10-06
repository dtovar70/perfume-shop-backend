import {
    layeredToLegacy,
    legacyToLayered,
    type DesignLayer,
    type LegacyDesignRow,
} from './design-legacy.js'

const ROW: LegacyDesignRow = {
    id: 'd1',
    original_key: 'kaizen/private/designs/abc.jpg',
    original_format: 'jpg',
    original_width: 2362,
    original_height: 1004,
    original_bytes: 812_345,
    placement: { x: 0.1, y: -0.2, scale: 0.8, rotation: 15, printWidthCm: 20, printHeightCm: 8.5 },
    dpi_estimate: 375,
}

describe('legacyToLayered', () => {
    it('turns the single image into one image layer and its original asset', () => {
        expect(legacyToLayered(ROW)).toEqual({
            layers: [
                {
                    type: 'image',
                    z: 0,
                    placement: { x: 0.1, y: -0.2, scale: 0.8, rotation: 15 },
                    assetIndex: 0,
                    format: 'jpg',
                    width: 2362,
                    height: 1004,
                    bytes: 812_345,
                    dpi: 375,
                },
            ],
            printSize: { widthCm: 20, heightCm: 8.5 },
            dpiEstimate: 375,
            asset: {
                design_id: 'd1',
                kind: 'original',
                layer_index: 0,
                storage_key: 'kaizen/private/designs/abc.jpg',
                format: 'jpg',
                width: 2362,
                height: 1004,
                bytes: 812_345,
            },
        })
    })

    it('falls back to a centered placement when the stored one is incomplete', () => {
        const mapped = legacyToLayered({
            ...ROW,
            placement: { x: 'left' },
            original_format: 'webp',
        })
        expect(mapped.layers[0]).toMatchObject({
            placement: { x: 0, y: 0, scale: 1, rotation: 0 },
            format: 'webp',
        })
        expect(mapped.printSize).toEqual({ widthCm: 0, heightCm: 0 })
    })
})

describe('layeredToLegacy', () => {
    it('round-trips a Stage 1 design', () => {
        const mapped = legacyToLayered(ROW)
        const back = layeredToLegacy(mapped.layers, mapped.printSize, [
            { ...mapped.asset, layer_index: 0 },
        ])
        const { id: _id, ...columns } = ROW
        expect(back).toEqual(columns)
    })

    it('keeps the bottom image layer that has its original', () => {
        const image = (dpi: number): DesignLayer => ({
            type: 'image',
            z: 0,
            placement: { x: 0, y: 0, scale: dpi / 100, rotation: 0 },
            assetIndex: 0,
            format: 'png',
            width: 10,
            height: 10,
            bytes: 10,
            dpi,
        })
        const text: DesignLayer = {
            type: 'text',
            z: 0,
            placement: { x: 0, y: 0, scale: 1, rotation: 0 },
            content: 'Luna',
            font: 'fredoka',
            color: '#000000',
            outline: 'none',
            align: 'center',
        }
        const asset = (layer: number, key: string) => ({
            kind: 'original',
            layer_index: layer,
            storage_key: key,
            format: 'png',
            width: 10,
            height: 10,
            bytes: 10,
        })
        const back = layeredToLegacy([text, image(100), image(200)], { widthCm: 5, heightCm: 5 }, [
            asset(2, 'top.png'),
            asset(1, 'bottom.png'),
        ])
        expect(back).toMatchObject({
            original_key: 'bottom.png',
            dpi_estimate: 100,
            placement: { scale: 1, printWidthCm: 5, printHeightCm: 5 },
        })
    })

    it('uses the arte final for a design with only text, and gives up without files', () => {
        const text: DesignLayer = {
            type: 'text',
            z: 0,
            placement: { x: 0, y: 0, scale: 1, rotation: 0 },
            content: 'Luna',
            font: 'fredoka',
            color: '#000000',
            outline: 'none',
            align: 'center',
        }
        const artwork = {
            kind: 'artwork',
            layer_index: null,
            storage_key: 'art.png',
            format: 'png',
            width: 394,
            height: 394,
            bytes: 5000,
        }
        expect(layeredToLegacy([text], { widthCm: 5, heightCm: 5 }, [artwork])).toEqual({
            original_key: 'art.png',
            original_format: 'png',
            original_width: 394,
            original_height: 394,
            original_bytes: 5000,
            placement: { x: 0, y: 0, scale: 1, rotation: 0, printWidthCm: 5, printHeightCm: 5 },
            dpi_estimate: 200,
        })
        expect(layeredToLegacy([text], { widthCm: 5, heightCm: 5 }, [])).toBeNull()
    })
})
