const TIMING_HEADER = /^Wall time: \d+(?:\.\d+)? seconds\nOutput:(?:\n|$)/
const CODE_MODE_HEADER = /^Script completed[\s\S]*\nOutput:\n$/

export function isDetachedResponsesContext(item) {
  return (
    item?.type === 'message' &&
    item.role === 'user' &&
    item.content?.[0]?.type === 'input_text' &&
    item.content[0].text === '[tool_result without a matching tool_call]'
  )
}

export function modelToolOutputText(output) {
  if (typeof output === 'string')
    return output
      .replace(TIMING_HEADER, '')
      .replace(/^Script completed\nWall time [^\n]+\nOutput:\n*/, '')
  if (!Array.isArray(output)) return JSON.stringify(output)
  return output
    .filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string')
    .map(part => part.text.replace(TIMING_HEADER, ''))
    .filter(text => !CODE_MODE_HEADER.test(text))
    .join('\n')
}

export function modelRequestTexts(body, role) {
  return (body.input ?? [])
    .filter(item => !role || item.role === role)
    .flatMap(item =>
      Array.isArray(item.content)
        ? item.content.map(part => part.text ?? '')
        : [item.output === undefined ? (item.content ?? '') : modelToolOutputText(item.output)]
    )
    .join('\n')
}
