const TIMING_HEADER = /^Wall time: \d+(?:\.\d+)? seconds\nOutput:(?:\n|$)/
const CODE_MODE_HEADER = /^Script (?:completed|running with cell ID)[\s\S]*\nOutput:\n$/

export function modelToolOutputText(output) {
  if (typeof output === 'string') return output.replace(TIMING_HEADER, '')
  if (!Array.isArray(output)) return JSON.stringify(output)
  return output
    .filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string')
    .map(part => part.text.replace(TIMING_HEADER, ''))
    .filter(text => !CODE_MODE_HEADER.test(text))
    .join('\n')
}
