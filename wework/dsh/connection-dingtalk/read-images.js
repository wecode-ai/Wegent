// Only native messages returned by the exact source read can supply download inputs.
export async function readImages(ctx, source, message, readTool) {
  const ids = [...message.text.matchAll(/\[图片消息\]\(mediaId=([^\s)]+)\)/g)].map(
    match => match[1]
  )
  const images = []
  for (const resourceId of new Set(ids)) {
    const result = await readTool(ctx, 'downloadImage', {
      resourceId,
      messageId: message.messageId,
      conversationId: message.conversationId,
      profile: source.profile,
    })
    if (typeof result.path !== 'string' || !result.path)
      throw Object.assign(new Error('DingTalk image download produced no image path'), {
        code: 'dingtalk_response_invalid',
      })
    images.push({ resourceId, path: result.path })
  }
  return images
}
