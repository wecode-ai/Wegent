import type { NativeImage } from 'electron'

const MACOS_TRAY_ICON_LOGICAL_SIZE = 18
const MACOS_TRAY_ICON_SCALE_FACTOR = 2
const MACOS_TRAY_ICON_PIXEL_SIZE = MACOS_TRAY_ICON_LOGICAL_SIZE * MACOS_TRAY_ICON_SCALE_FACTOR
const MACOS_TRAY_TEXT_GAP = 8
const MACOS_TRAY_GLYPH_WIDTH = 5
const MACOS_TRAY_GLYPH_HEIGHT = 7
const MACOS_TRAY_GLYPH_SCALE = 2
const MACOS_TRAY_GLYPH_GAP = 2
const MACOS_TRAY_SPACE_WIDTH = 4
const MACOS_TRAY_LINE_GAP = 4
const MACOS_TRAY_TEXT_RIGHT_PADDING = 2
const MACOS_TRAY_RUNNING_METER_WIDTH = 6
const MACOS_TRAY_RUNNING_METER_GAP = 8

const TRAY_GLYPHS: Readonly<Record<string, readonly number[]>> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '%': [0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b00110, 0b00000],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  '-': [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  ',': [0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00110, 0b00100],
}

export interface NativeImageFactory {
  createFromBitmap(
    buffer: Buffer,
    options: { width: number; height: number; scaleFactor: number }
  ): NativeImage
  createFromPath(path: string): NativeImage
}

export function convertToTemplateBitmap(bitmap: Buffer): Buffer {
  const template = Buffer.from(bitmap)
  for (let offset = 0; offset + 3 < template.length; offset += 4) {
    const mask = 255 - Math.min(template[offset], template[offset + 1], template[offset + 2])
    template[offset] = 0
    template[offset + 1] = 0
    template[offset + 2] = 0
    template[offset + 3] = Math.round((template[offset + 3] * mask) / 255)
  }
  return template
}

function usageLines(title: string | null): string[] {
  if (!title) return []
  return title
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2)
}

function glyphAdvance(character: string): number {
  return character === ' '
    ? MACOS_TRAY_SPACE_WIDTH + MACOS_TRAY_GLYPH_GAP
    : MACOS_TRAY_GLYPH_WIDTH * MACOS_TRAY_GLYPH_SCALE + MACOS_TRAY_GLYPH_GAP
}

function usageLineWidth(line: string): number {
  return Math.max(
    1,
    [...line].reduce((width, character) => width + glyphAdvance(character), 0) -
      MACOS_TRAY_GLYPH_GAP
  )
}

function drawPixel(bitmap: Buffer, width: number, x: number, y: number, alpha: number): void {
  if (x < 0 || y < 0 || x >= width || y >= MACOS_TRAY_ICON_PIXEL_SIZE) return
  const offset = (y * width + x) * 4
  bitmap[offset] = 0
  bitmap[offset + 1] = 0
  bitmap[offset + 2] = 0
  bitmap[offset + 3] = alpha
}

function drawRect(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  alpha: number
): void {
  for (let dy = 0; dy < rectHeight; dy += 1) {
    for (let dx = 0; dx < rectWidth; dx += 1) {
      drawPixel(bitmap, width, x + dx, y + dy, alpha)
    }
  }
}

function drawRunningMeter(bitmap: Buffer, width: number, x: number, runningCount: number): void {
  drawRect(bitmap, width, x, 2, 6, 32, 120)
  drawRect(bitmap, width, x + 1, 3, 4, 30, 0)
  const fillHeight = Math.round((Math.min(4, Math.max(0, runningCount)) / 4) * 30)
  if (fillHeight > 0) {
    drawRect(bitmap, width, x + 1, 33 - fillHeight, 4, fillHeight, 235)
  }
}

function drawUsageText(bitmap: Buffer, width: number, lines: string[], x: number): void {
  const textHeight =
    lines.length * MACOS_TRAY_GLYPH_HEIGHT * MACOS_TRAY_GLYPH_SCALE +
    Math.max(0, lines.length - 1) * MACOS_TRAY_LINE_GAP
  const firstY = Math.floor((MACOS_TRAY_ICON_PIXEL_SIZE - textHeight) / 2)

  lines.forEach((line, lineIndex) => {
    let cursorX = x
    const y =
      firstY + lineIndex * (MACOS_TRAY_GLYPH_HEIGHT * MACOS_TRAY_GLYPH_SCALE + MACOS_TRAY_LINE_GAP)
    for (const character of line) {
      if (character !== ' ') {
        const glyph = TRAY_GLYPHS[character.toUpperCase()]
        glyph?.forEach((row, rowIndex) => {
          for (let column = 0; column < MACOS_TRAY_GLYPH_WIDTH; column += 1) {
            if ((row & (1 << (MACOS_TRAY_GLYPH_WIDTH - column - 1))) === 0) continue
            const pixelX = cursorX + column * MACOS_TRAY_GLYPH_SCALE
            const pixelY = y + rowIndex * MACOS_TRAY_GLYPH_SCALE
            drawRect(
              bitmap,
              width,
              pixelX,
              pixelY,
              MACOS_TRAY_GLYPH_SCALE,
              MACOS_TRAY_GLYPH_SCALE,
              255
            )
          }
        })
      }
      cursorX += glyphAdvance(character)
    }
  })
}

function createMacosTrayBitmap(
  icon: NativeImage,
  lines: string[],
  runningCount: number,
  showRunningStatus: boolean
): { bitmap: Buffer; width: number } {
  const meterWidth = showRunningStatus
    ? MACOS_TRAY_RUNNING_METER_WIDTH + MACOS_TRAY_RUNNING_METER_GAP
    : 0
  const textWidth = lines.length > 0 ? Math.max(...lines.map(usageLineWidth)) : 0
  const width =
    MACOS_TRAY_ICON_PIXEL_SIZE +
    meterWidth +
    (textWidth > 0 ? MACOS_TRAY_TEXT_GAP + textWidth + MACOS_TRAY_TEXT_RIGHT_PADDING : 0)
  const bitmap = Buffer.alloc(width * MACOS_TRAY_ICON_PIXEL_SIZE * 4)
  const iconBitmap = icon.toBitmap({ scaleFactor: 1 })
  for (let y = 0; y < MACOS_TRAY_ICON_PIXEL_SIZE; y += 1) {
    const sourceStart = y * MACOS_TRAY_ICON_PIXEL_SIZE * 4
    const targetStart = y * width * 4
    iconBitmap.copy(bitmap, targetStart, sourceStart, sourceStart + MACOS_TRAY_ICON_PIXEL_SIZE * 4)
  }
  if (showRunningStatus) {
    drawRunningMeter(bitmap, width, MACOS_TRAY_ICON_PIXEL_SIZE + 5, runningCount)
  }
  const textX = MACOS_TRAY_ICON_PIXEL_SIZE + meterWidth + MACOS_TRAY_TEXT_GAP
  drawUsageText(bitmap, width, lines, textX)

  return { bitmap, width }
}

export function createTrayIcon(
  images: NativeImageFactory,
  iconPath: string,
  usageTitle: string | null = null,
  platform: NodeJS.Platform = process.platform,
  status: { runningCount: number; showRunningStatus: boolean } = {
    runningCount: 0,
    showRunningStatus: false,
  }
): NativeImage {
  const source = images.createFromPath(iconPath)
  if (source.isEmpty()) {
    throw new Error(`Tray icon could not be loaded: ${iconPath}`)
  }
  if (platform !== 'darwin') {
    return source
  }

  const resized = source.resize({
    width: MACOS_TRAY_ICON_PIXEL_SIZE,
    height: MACOS_TRAY_ICON_PIXEL_SIZE,
    quality: 'best',
  })
  const baseIcon = images.createFromBitmap(
    convertToTemplateBitmap(resized.toBitmap({ scaleFactor: 1 })),
    {
      width: MACOS_TRAY_ICON_PIXEL_SIZE,
      height: MACOS_TRAY_ICON_PIXEL_SIZE,
      scaleFactor: 1,
    }
  )
  const lines = usageLines(usageTitle)
  const rendered = createMacosTrayBitmap(
    baseIcon,
    lines,
    status.runningCount,
    status.showRunningStatus
  )
  const template = images.createFromBitmap(rendered.bitmap, {
    width: rendered.width,
    height: MACOS_TRAY_ICON_PIXEL_SIZE,
    scaleFactor: MACOS_TRAY_ICON_SCALE_FACTOR,
  })
  template.setTemplateImage(true)
  return template
}
