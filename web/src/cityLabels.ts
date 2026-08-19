import * as THREE from 'three'

/**
 * Ground labels that name each building and facility on the map.
 *
 * A label carries identity and nothing else. It never restates a measurement and never qualifies
 * one: footprint, height, roof cap, road width, lane width, and colour keep their documented
 * meanings, and reading a label tells you only which object you are looking at. That matters most
 * when schema neighborhoods are switched off, because the district tint is then no longer there to
 * say which schema a building belongs to -- so a building label is schema-qualified.
 *
 * Labels are drawn in front of every other object rather than depth-tested against the city. A name
 * hidden behind the building it names is worth nothing, and at the default framing most of them were
 * hidden. The cost is that a label can overlap geometry it does not name, so a label is always
 * anchored at its own building's kerb and the evidence tables below the map remain authoritative.
 *
 * Rasterization lives behind {@link createCityLabels}. The text and geometry decisions above it are
 * pure functions so they can be tested without a DOM or a GPU.
 */

/** Glyph height used when rasterizing. World size is applied separately, so this is quality only. */
const FONT_PX = 56
const PAD_X = 20
const PAD_Y = 12
/**
 * Height of a label in world units. Labels are size-attenuated, so they still shrink with distance;
 * this sets how large they are at a given range. Sized so a name stays readable from the default
 * framing, where a label competes with towers several times its height for attention.
 */
export const LABEL_WORLD_HEIGHT = 6.2
/**
 * Longest label drawn before the middle is elided. A wide texture costs both memory and legibility,
 * and the full name is always available in the evidence tables and the detail panel.
 *
 * Width scales with {@link LABEL_WORLD_HEIGHT}, so a long name at the current height spans several
 * lots. This limit is what keeps that in hand; the elision is from the middle, so both ends of a
 * name survive.
 */
export const LABEL_MAX_CHARS = 24

const ELLIPSIS = '…'

/**
 * Schema-qualifies a building label. The qualifier is what a district tint used to convey, so it is
 * kept even though it costs width.
 */
export function buildingLabelText(schemaName: string, name: string): string {
  const qualified = schemaName.length > 0 ? `${schemaName}.${name}` : name
  return elideMiddle(qualified, LABEL_MAX_CHARS)
}

/**
 * Shortens from the middle rather than the end. A name's tail is often what distinguishes it
 * (`orders_2024_archive` against `orders_2024_current`), so a trailing elision would merge labels
 * that name different buildings.
 */
export function elideMiddle(text: string, maxChars: number): string {
  const characters = [...text]
  if (maxChars <= 0) return ''
  if (characters.length <= maxChars) return text
  if (maxChars === 1) return ELLIPSIS
  const keep = maxChars - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${characters.slice(0, head).join('')}${ELLIPSIS}${tail === 0 ? '' : characters.slice(-tail).join('')}`
}

/** Sprite width in world units that preserves the rasterized aspect ratio at {@link LABEL_WORLD_HEIGHT}. */
export function labelWorldWidth(pixelWidth: number, pixelHeight: number, worldHeight = LABEL_WORLD_HEIGHT): number {
  if (!(pixelHeight > 0) || !(pixelWidth > 0)) return 0
  return worldHeight * (pixelWidth / pixelHeight)
}

/**
 * Places a label on the street side of its building.
 *
 * A label sits at the kerb the building is entered from, so it lands on open pavement instead of
 * inside the footprint it names. `accessX`/`accessZ` is the same frontage point the GPS route stops
 * at, which keeps the label and the route agreeing about where a building's front is. When the two
 * points coincide there is no direction to push toward, so the centre is used unchanged.
 */
export function labelAnchor(
  centerX: number,
  centerZ: number,
  accessX: number,
  accessZ: number,
  distance: number,
): { x: number; z: number } {
  const dx = accessX - centerX
  const dz = accessZ - centerZ
  const length = Math.hypot(dx, dz)
  if (length === 0) return { x: centerX, z: centerZ }
  return { x: centerX + (dx / length) * distance, z: centerZ + (dz / length) * distance }
}

export type CityLabels = {
  /** Returns null when the browser refuses a 2D context, so the caller simply draws no label. */
  make(text: string): THREE.Sprite | null
  dispose(): void
}

/** A rasterized label: the shared material plus the pixel size the sprite scale is derived from. */
type RasterizedLabel = {
  material: THREE.SpriteMaterial
  pixelWidth: number
  pixelHeight: number
}

/**
 * Builds label sprites, caching one texture per distinct string.
 *
 * The cache is what makes labels affordable: the scene rebuilds its buildings on every live tick
 * and on every appended page, and rasterizing a fresh canvas per building per tick would churn GPU
 * textures for text that never changed. Sprites are cheap wrappers over the shared material, so
 * only {@link CityLabels.dispose} frees GPU memory.
 */
export function createCityLabels(): CityLabels {
  const cache = new Map<string, RasterizedLabel | null>()

  function rasterize(text: string): RasterizedLabel | null {
    const cached = cache.get(text)
    if (cached !== undefined) return cached

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) {
      cache.set(text, null)
      return null
    }

    const font = `600 ${FONT_PX}px "Segoe UI", system-ui, sans-serif`
    context.font = font
    const measured = Math.ceil(context.measureText(text).width)
    canvas.width = measured + PAD_X * 2
    canvas.height = FONT_PX + PAD_Y * 2

    // Resizing a canvas resets its 2D state, so the font has to be set again before drawing.
    context.font = font
    context.textAlign = 'center'
    context.textBaseline = 'middle'

    // A dark plate keeps the text legible over ground, asphalt, and district tint alike.
    context.fillStyle = 'rgba(7, 11, 17, 0.82)'
    roundedRect(context, 0, 0, canvas.width, canvas.height, PAD_Y + 2)
    context.fill()
    context.strokeStyle = 'rgba(159, 198, 232, 0.35)'
    context.lineWidth = 2
    context.stroke()

    context.fillStyle = '#e8f1f8'
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 1)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // The canvas is not power-of-two, so mipmapping would need a resize; labels are read up close.
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = 4

    const entry: RasterizedLabel = {
      material: new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        // Labels ignore the depth buffer so a building can never hide the name of the building
        // behind it. Identity is the one thing that must survive any camera angle: a name you
        // cannot read is no more useful than no name at all.
        depthTest: false,
      }),
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
    }
    cache.set(text, entry)
    return entry
  }

  return {
    make(text) {
      const entry = rasterize(text)
      if (!entry) return null
      const sprite = new THREE.Sprite(entry.material)
      sprite.scale.set(labelWorldWidth(entry.pixelWidth, entry.pixelHeight), LABEL_WORLD_HEIGHT, 1)
      // Above every other render order in the scene, so labels resolve last and against each other
      // by camera distance rather than by the order buildings happened to be added.
      sprite.renderOrder = 10
      return sprite
    },
    dispose() {
      for (const entry of cache.values()) {
        entry?.material.map?.dispose()
        entry?.material.dispose()
      }
      cache.clear()
    },
  }
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const limit = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + limit, y)
  context.arcTo(x + width, y, x + width, y + height, limit)
  context.arcTo(x + width, y + height, x, y + height, limit)
  context.arcTo(x, y + height, x, y, limit)
  context.arcTo(x, y, x + width, y, limit)
  context.closePath()
}
