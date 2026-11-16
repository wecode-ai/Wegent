import type { Attachment } from './runtime'

export interface GeneratedImageArtifact {
  id: string
  alt: string
  mimeType: string
  fileExtension: string
  size: number
  width?: number
  height?: number
  src?: string
  workspaceFile?: Attachment['workspace_file']
}

const GENERATED_IMAGE_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

function resolveGeneratedImageType(
  mimeType: unknown,
  dataUrl?: string
): { mimeType: string; fileExtension: string } | null {
  const dataUrlMimeType = /^data:([^;,]+)/i.exec(dataUrl ?? '')?.[1]
  const normalizedMimeType =
    (dataUrlMimeType ?? (typeof mimeType === 'string' ? mimeType : 'image/png'))
      .split(';', 1)[0]
      .trim()
      .toLowerCase() || 'image/png'
  const fileExtension = GENERATED_IMAGE_FILE_EXTENSIONS[normalizedMimeType]
  return fileExtension ? { mimeType: normalizedMimeType, fileExtension } : null
}

export function getGeneratedImages(
  blocks: ReadonlyArray<{
    id: string
    type: string
    toolName?: string
    renderPayload?: unknown
  }>,
  fallbackAlt: string
): GeneratedImageArtifact[] {
  return blocks.flatMap((block): GeneratedImageArtifact[] => {
    if (block.type !== 'tool' || block.toolName !== 'image_generation') return []
    const payload = block.renderPayload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
    const source = Reflect.get(payload, 'source')
    const revisedPrompt = Reflect.get(payload, 'revisedPrompt')
    const alt =
      typeof revisedPrompt === 'string' && revisedPrompt.trim() ? revisedPrompt : fallbackAlt
    if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
      const sourceType = Reflect.get(source, 'type')
      const deviceId = Reflect.get(source, 'deviceId')
      const workspacePath = Reflect.get(source, 'workspacePath')
      const path = Reflect.get(source, 'path')
      if (
        sourceType === 'workspace_file' &&
        typeof deviceId === 'string' &&
        deviceId.trim() &&
        typeof workspacePath === 'string' &&
        workspacePath.trim() &&
        typeof path === 'string' &&
        path.trim()
      ) {
        const imageType = resolveGeneratedImageType(Reflect.get(payload, 'mimeType'))
        if (!imageType) return []
        const size = Reflect.get(payload, 'size')
        const width = Reflect.get(payload, 'width')
        const height = Reflect.get(payload, 'height')
        return [
          {
            id: block.id,
            alt,
            ...imageType,
            size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
            width:
              typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : undefined,
            height:
              typeof height === 'number' && Number.isFinite(height) && height > 0
                ? height
                : undefined,
            workspaceFile: {
              device_id: deviceId,
              workspace_path: workspacePath,
              path,
            },
          },
        ]
      }
    }
    const imageBase64 = Reflect.get(payload, 'imageBase64')
    if (typeof imageBase64 !== 'string' || !imageBase64.trim()) return []
    const imageType = resolveGeneratedImageType(Reflect.get(payload, 'mimeType'), imageBase64)
    if (!imageType) return []
    return [
      {
        id: block.id,
        src: imageBase64.startsWith('data:')
          ? imageBase64
          : `data:${imageType.mimeType};base64,${imageBase64}`,
        alt,
        ...imageType,
        size: 0,
      },
    ]
  })
}
