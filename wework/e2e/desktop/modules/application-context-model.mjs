import { modelMessageText } from './response-protocol.mjs'

export function modelApplicationContextText(body, key) {
  const open = `<${key}>`
  const close = `</${key}>`
  for (const message of (body.input ?? []).toReversed()) {
    if (message.role !== 'developer') continue
    const text = modelMessageText(message)
    const start = text.indexOf(open)
    if (start < 0) continue
    const end = text.indexOf(close, start + open.length)
    if (end >= 0) return text.slice(start + open.length, end)
  }
  return ''
}
