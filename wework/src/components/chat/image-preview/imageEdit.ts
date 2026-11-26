import type { TFunction } from 'i18next'
import type { Attachment } from '@/types/api'
import i18n from '@/i18n'
import { isImageAttachment } from '@/lib/attachments'
import { reportImageCommentStage } from '@/lib/file-preview-diagnostics'
import { markupSurfaceSize, strokeGeometry, type ImageMark } from './imageMarkup'

export interface ImagePoint {
  x: number
  y: number
  pressure?: number
}

export interface ImageStroke {
  points: ImagePoint[]
  width: number
}

export type ImageComment = NonNullable<Attachment['image_markup_comments']>[number]

export const imageAspectRatios = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const

export type ImageEdit =
  | { kind: 'markup'; marks: ImageMark[]; instructions: string; comments?: ImageComment[] }
  | { kind: 'comment'; comments: ImageComment[] }
  | { kind: 'erase'; strokes: ImageStroke[] }
  | { kind: 'background' }
  | { kind: 'resize'; ratio: (typeof imageAspectRatios)[number] }

export function hasImageMarkupComments(attachments: Attachment[]): boolean {
  return attachments.some(attachment => Boolean(attachment.image_markup_comments?.length))
}

export function composeImageMarkupMessage(
  content: string,
  attachments: Attachment[],
  precedingAttachments: Attachment[] = []
) {
  const parts = [content]
  const locale = i18n.resolvedLanguage ?? i18n.language
  const t = i18n.getFixedT(locale, 'common')
  let imageNumber = precedingAttachments.filter(isImageAttachment).length
  const precedingImageCount = imageNumber
  let pinCount = 0
  const images = attachments.map(attachment => {
    if (isImageAttachment(attachment)) imageNumber += 1
    const { image_markup_comments: comments, ...image } = attachment
    if (comments === undefined) return attachment
    if (comments.length) {
      pinCount += comments.length
      parts.push(formatComments(comments, t, locale, imageNumber))
    }
    return image
  })
  const body = parts.filter(Boolean).join('\n\n')
  if (imageNumber > precedingImageCount) {
    reportImageCommentStage('message_composed', {
      imageCount: imageNumber - precedingImageCount,
      pinCount,
      hasText: Boolean(body),
    })
  }
  return { content: body, attachments: images }
}

function formatComments(
  comments: ImageComment[],
  t: TFunction<'common'>,
  locale: string,
  imageNumber = 1
) {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  const coordinate = (value: number) => percent.format(Math.min(100, Math.max(0, value)) / 100)
  return [
    t('image_preview.comment_image_heading', { number: imageNumber }),
    ...comments.map(({ x, y, text }, index) =>
      t('image_preview.comment_message', {
        number: index + 1,
        x: coordinate(x),
        y: coordinate(y),
        text,
        interpolation: { escapeValue: false },
      })
    ),
  ].join('  \n')
}

export function imageEditPrompt(edit: ImageEdit, t: TFunction<'common'>, locale: string): string {
  switch (edit.kind) {
    case 'markup':
      return [
        edit.comments?.length ? formatComments(edit.comments, t, locale) : '',
        edit.instructions.trim(),
      ]
        .filter(Boolean)
        .join('\n\n')
    case 'comment':
      return formatComments(edit.comments, t, locale)
    case 'erase':
      return 'Use the image generation tool to remove the area marked in white in the second image from the first image. Fill it naturally and preserve everything else.'
    case 'background':
      return 'Use the image generation tool to remove the background from this image. Keep all foreground subjects unchanged and fully intact, with clean, smooth edges. Make the background transparent.'
    case 'resize':
      return `Use the image generation tool to make the aspect ratio ${edit.ratio}. Preserve the foreground subjects.`
  }
}

export async function renderImageEditSelection(
  original: File,
  edit: Extract<ImageEdit, { kind: 'markup' | 'erase' }>
): Promise<File> {
  const image = await createImageBitmap(original)
  try {
    if (image.width * image.height > 20_000_000)
      throw new Error('The image is too large to mark up')
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create the image selection')
    if (edit.kind === 'markup') {
      context.drawImage(image, 0, 0)
      paintMarkup(context, edit.marks, image.width, image.height)
    } else {
      context.fillStyle = 'black'
      context.fillRect(0, 0, image.width, image.height)
      const { scale } = markupSurfaceSize(image)
      context.scale(scale, scale)
      context.strokeStyle = 'white'
      for (const stroke of edit.strokes) paintStroke(context, stroke)
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not export the image selection')
    return new File([blob], edit.kind === 'erase' ? 'selection-mask.png' : 'annotated-image.png', {
      type: 'image/png',
    })
  } finally {
    image.close()
  }
}

function paintStroke(context: CanvasRenderingContext2D, stroke: ImageStroke) {
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = stroke.width
  const { path, filled } = strokeGeometry(stroke)
  const geometry = new Path2D(path)
  if (filled) {
    context.fillStyle = context.strokeStyle
    context.fill(geometry)
  } else {
    context.stroke(geometry)
  }
}

function paintMark(context: CanvasRenderingContext2D, mark: ImageMark) {
  if ('text' in mark) {
    context.fillStyle = mark.color
    context.font = `${mark.size}px sans-serif`
    context.fillText(mark.text, mark.point.x, mark.point.y)
  } else {
    context.strokeStyle = mark.color
    paintStroke(context, mark)
  }
}

function paintMarkup(
  context: CanvasRenderingContext2D,
  marks: ImageMark[],
  width: number,
  height: number
) {
  const { scale } = markupSurfaceSize({ width, height })
  if (!marks.some(mark => mark.erasures?.length)) {
    context.scale(scale, scale)
    for (const mark of marks) paintMark(context, mark)
    return
  }

  // A mark's cuts apply only to that mark. Composite it over prior marks and the image afterward.
  const layer = document.createElement('canvas')
  layer.width = width
  layer.height = height
  const markContext = layer.getContext('2d')
  if (!markContext) throw new Error('Could not create the image markup layer')
  for (const mark of marks) {
    if (!mark.erasures?.length) {
      context.save()
      context.scale(scale, scale)
      paintMark(context, mark)
      context.restore()
      continue
    }
    markContext.clearRect(0, 0, width, height)
    markContext.save()
    markContext.scale(scale, scale)
    paintMark(markContext, mark)
    markContext.globalCompositeOperation = 'destination-out'
    for (const cut of mark.erasures) paintStroke(markContext, cut)
    markContext.restore()
    context.drawImage(layer, 0, 0)
  }
}
