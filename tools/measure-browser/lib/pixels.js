/*
 * Minimal PNG reader for measurement probes.
 *
 * Playwright hands back a PNG buffer, and a screenshot is the *presented* pixels -- which is the
 * point. Reading the WebGL drawing buffer with `readPixels` after the frame has been composited
 * returns a cleared buffer unless the context was created with `preserveDrawingBuffer`, and the app
 * does not create it that way. So the screenshot is not a convenience here, it is the only honest
 * source. Node ships zlib, so decoding it needs no dependency.
 *
 * Handles the one case Chromium emits: 8-bit, non-interlaced, colour type 6 (RGBA) or 2 (RGB).
 */
import { inflateSync } from 'node:zlib'

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  let bitDepth = 8
  const idat = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`unsupported colour type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    // Undo the per-scanline filter. Byte-wise, against the pixel to the left (`a`), the byte
    // directly above (`b`) and the one above-left (`c`), exactly as the spec defines them.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = value & 0xff
    }
    previous = line
    for (let x = 0; x < width; x += 1) {
      const src = x * channels
      const dst = (y * width + x) * 4
      out[dst] = line[src]
      out[dst + 1] = line[src + 1]
      out[dst + 2] = line[src + 2]
      out[dst + 3] = channels === 4 ? line[src + 3] : 255
    }
  }

  return { width, height, pixels: out }
}

/**
 * Per-object bounding boxes for pixels matching a predicate.
 *
 * A single global bounding box over one colour spans every instance of that colour at once -- two
 * fires on opposite sides of the city measure as one box the width of the screen. Connected
 * components is what makes "how big is a flame" answerable. Dilation joins the dithered pixels of a
 * translucent plume, which is otherwise scattered rather than solid.
 */
export function components(image, matches, { dilate = 3, minPixels = 12 } = {}) {
  const { width, height, pixels } = image
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    if (matches(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2])) mask[i] = 1
  }

  const seen = new Uint8Array(width * height)
  const found = []
  const stack = []

  for (let start = 0; start < width * height; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    let count = 0

    while (stack.length > 0) {
      const index = stack.pop()
      const x = index % width
      const y = (index - x) / width
      count += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      for (let dy = -dilate; dy <= dilate; dy += 1) {
        for (let dx = -dilate; dx <= dilate; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (mask[n] === 1 && seen[n] === 0) {
            seen[n] = 1
            stack.push(n)
          }
        }
      }
    }

    if (count >= minPixels) {
      found.push({ pixels: count, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 })
    }
  }

  return found.sort((a, b) => b.pixels - a.pixels)
}
