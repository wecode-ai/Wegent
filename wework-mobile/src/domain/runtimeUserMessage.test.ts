import { describe, expect, it } from 'vitest'

import { splitRuntimeUserMessage, visibleRuntimeUserMessage } from './runtimeUserMessage'

describe('runtime user message', () => {
  it('extracts visible input from attachment wrappers', () => {
    const content = [
      '# Files mentioned by the user:',
      '',
      '## image.png: /tmp/image.png',
      '',
      '## My request for Codex:',
      '',
      'Fix the sidebar',
    ].join('\n')

    expect(splitRuntimeUserMessage(content)).toEqual({
      prefix: '# Files mentioned by the user:\n\n## image.png: /tmp/image.png\n\n',
      request: 'Fix the sidebar',
    })
    expect(visibleRuntimeUserMessage(content)).toBe('Fix the sidebar')
  })
})
