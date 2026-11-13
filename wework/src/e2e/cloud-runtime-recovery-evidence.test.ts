import { afterEach, expect, test } from 'vitest'
import { assertSingleRecoveredCloudAnswer } from '../../e2e/desktop/scenarios/cloud-runtime-recovery.scenario.mjs'

const answer = 'CLOUD_STREAM_PARTIAL_COMPLETED_WHILE_DISCONNECTED'
const control = {
  async command(action: string, selector: string) {
    expect(action).toBe('getText')
    return Array.from(document.querySelectorAll(selector))
      .map(element => element.textContent?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
  },
}

afterEach(() => document.body.replaceChildren())

function mountConversation(answers: string[]) {
  document.body.innerHTML = `
    <main data-testid="desktop-workbench-main">
      <nav data-testid="message-turn-navigation-preview">${answer}</nav>
      ${answers.map(text => `<article data-testid="message-assistant">${text}</article>`).join('')}
    </main>`
}

test('counts recovered answers independently of the mounted turn-navigation preview', async () => {
  mountConversation([answer])
  await expect(assertSingleRecoveredCloudAnswer(control)).resolves.toBeUndefined()
})

test.each([[answer, answer], [`${answer}${answer}`], []])(
  'rejects missing or duplicated recovered assistant output: %j',
  async (...answers) => {
    mountConversation(answers)
    await expect(assertSingleRecoveredCloudAnswer(control)).rejects.toThrow(
      'Recovery duplicated the completed answer'
    )
  }
)
