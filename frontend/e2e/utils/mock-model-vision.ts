export interface VisionMessage {
  role: string
  content:
    | string
    | Array<{
        type: string
        text?: string
        image_url?: {
          url: string
        }
      }>
}

/**
 * Verify if a message contains valid image_url format
 */
export function verifyImageUrlInMessage(message: VisionMessage): {
  hasImageUrl: boolean
  imageUrlPrefix?: string
  isValidFormat: boolean
  details: string
} {
  if (typeof message.content === 'string') {
    return {
      hasImageUrl: false,
      isValidFormat: false,
      details: 'Content is a string, not vision format',
    }
  }

  if (!Array.isArray(message.content)) {
    return {
      hasImageUrl: false,
      isValidFormat: false,
      details: 'Content is not an array',
    }
  }

  let hasText = false
  let hasImageUrl = false
  let imageUrlPrefix: string | undefined

  for (const item of message.content) {
    if (item.type === 'text' && item.text) {
      hasText = true
    }
    if (item.type === 'image_url' && item.image_url?.url) {
      hasImageUrl = true
      const match = item.image_url.url.match(/^(data:image\/[^;]+;base64,)/)
      if (match) {
        imageUrlPrefix = match[1]
      }
    }
  }

  return {
    hasImageUrl,
    imageUrlPrefix,
    isValidFormat: hasText && hasImageUrl && !!imageUrlPrefix,
    details: `hasText=${hasText}, hasImageUrl=${hasImageUrl}, prefix=${imageUrlPrefix || 'none'}`,
  }
}
