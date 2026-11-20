import assert from 'node:assert/strict'

const TIMING_HEADER = /^Wall time: \d+(?:\.\d+)? seconds\nOutput:(?:\n|$)/
const CODE_MODE_HEADER = /^Script completed[\s\S]*\nOutput:\n$/

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

export function readPreparedQuestionAttachmentPath(answers, filename) {
  const prefix = `- ${filename} (`
  const paths = answers
    .flatMap(answer => answer.split('\n'))
    .filter(line => line.startsWith(prefix))
    .map(line => line.match(/\): (.+)$/)?.[1])
    .filter(Boolean)
  assert.equal(paths.length, 1, `Expected one prepared question attachment: ${filename}`)
  return paths[0]
}
