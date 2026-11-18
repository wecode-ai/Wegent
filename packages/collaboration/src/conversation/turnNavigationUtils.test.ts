import { expect, test } from 'vitest'
import { buildUserTurnsForNavigation } from './turnNavigationUtils'

test('does not restore raw native visualization previews over loaded prose', () => {
  const content = 'visualize{"path":"/tmp/chart.html"}'
  const messages = [
    { id: 'user', role: 'user', content: 'Show chart', turnId: 'turn' },
    { id: 'answer', role: 'assistant', content, turnId: 'turn' },
  ]
  expect(buildUserTurnsForNavigation(messages)[0].responsePreview).toBe('')
  expect(buildUserTurnsForNavigation(messages, [{
    id: 'user', turnId: 'turn', turnIndex: 0, messageIndex: 0,
    promptPreview: 'Show chart', responsePreview: content,
  }])[0].responsePreview).toBe('')
})
