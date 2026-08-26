import type { NativeImage } from 'electron'

const MACOS_TRAY_ICON_LOGICAL_SIZE = 18
const MACOS_TRAY_ICON_SCALE_FACTOR = 2
const MACOS_TRAY_ICON_PIXEL_SIZE = MACOS_TRAY_ICON_LOGICAL_SIZE * MACOS_TRAY_ICON_SCALE_FACTOR
const MACOS_TRAY_TEXT_GAP = 8
const MACOS_TRAY_TEXT_FONT_SIZE = 18
const MACOS_TRAY_TEXT_CHARACTER_WIDTH = 11
const MACOS_TRAY_TEXT_RIGHT_PADDING = 2
const MACOS_TRAY_RUNNING_METER_WIDTH = 6
const MACOS_TRAY_RUNNING_METER_GAP = 8

export interface NativeImageFactory {
  createFromBitmap(
    buffer: Buffer,
    options: { width: number; height: number; scaleFactor: number }
  ): NativeImage
  createFromDataURL(dataUrl: string): NativeImage
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

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function usageLines(title: string | null): string[] {
  if (!title) return []
  return title
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2)
}

function createRunningMeter(runningCount: number, showRunningStatus: boolean): string {
  if (!showRunningStatus) return ''
  const level = Math.min(4, Math.max(0, runningCount))
  const fillHeight = Math.round((level / 4) * 30)
  const fill =
    fillHeight > 0
      ? `<rect x="42" y="${33 - fillHeight}" width="4" height="${fillHeight}" opacity="0.92"/>`
      : ''
  return `<g fill="black"><path d="M41 2h6v32h-6zM42 3v30h4V3z" fill-rule="evenodd" opacity="0.47"/>${fill}</g>`
}

function createMacosTraySvg(
  icon: NativeImage,
  lines: string[],
  runningCount: number,
  showRunningStatus: boolean
): string {
  const meterWidth = showRunningStatus
    ? MACOS_TRAY_RUNNING_METER_WIDTH + MACOS_TRAY_RUNNING_METER_GAP
    : 0
  const textWidth =
    (lines.length > 0 ? Math.max(...lines.map(line => line.length)) : 0) *
    MACOS_TRAY_TEXT_CHARACTER_WIDTH
  const width =
    MACOS_TRAY_ICON_PIXEL_SIZE +
    meterWidth +
    (lines.length > 0 ? MACOS_TRAY_TEXT_GAP + textWidth + MACOS_TRAY_TEXT_RIGHT_PADDING : 0)
  const iconDataUrl = `data:image/png;base64,${icon.toPNG({ scaleFactor: 1 }).toString('base64')}`
  const textX = MACOS_TRAY_ICON_PIXEL_SIZE + meterWidth + MACOS_TRAY_TEXT_GAP
  const text = lines
    .map((line, index) => {
      const y = lines.length === 1 ? 25 : index === 0 ? 14 : 31
      return `<text x="${textX}" y="${y}">${escapeXml(line)}</text>`
    })
    .join('')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${MACOS_TRAY_ICON_PIXEL_SIZE}" viewBox="0 0 ${width} ${MACOS_TRAY_ICON_PIXEL_SIZE}">`,
    `<image href="${iconDataUrl}" width="${MACOS_TRAY_ICON_PIXEL_SIZE}" height="${MACOS_TRAY_ICON_PIXEL_SIZE}"/>`,
    createRunningMeter(runningCount, showRunningStatus),
    `<g fill="black" font-family="SFMono-Regular,Menlo,monospace" font-size="${MACOS_TRAY_TEXT_FONT_SIZE}" font-weight="600" xml:space="preserve">${text}</g>`,
    '</svg>',
  ].join('')
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
  const rendered =
    lines.length === 0 && !status.showRunningStatus
      ? baseIcon
      : images.createFromDataURL(
          `data:image/svg+xml;base64,${Buffer.from(
            createMacosTraySvg(baseIcon, lines, status.runningCount, status.showRunningStatus)
          ).toString('base64')}`
        )
  if (rendered.isEmpty()) {
    throw new Error('macOS tray icon could not be rendered')
  }
  const size = rendered.getSize()
  const template = images.createFromBitmap(rendered.toBitmap({ scaleFactor: 1 }), {
    width: size.width,
    height: size.height,
    scaleFactor: MACOS_TRAY_ICON_SCALE_FACTOR,
  })
  template.setTemplateImage(true)
  return template
}
