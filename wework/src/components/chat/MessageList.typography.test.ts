import { afterEach, expect, test } from 'vitest'
import { readMessageLayoutTypography } from '../../../../packages/collaboration/src/conversation/messagePretextLayout'

afterEach(() => document.body.replaceChildren())

test('virtualizing a compact plan preserves the conversation body typography', () => {
  const list = document.createElement('div')
  list.innerHTML = `
    <article data-testid="message-assistant">
      <p data-scroll-anchor style="line-height: 24px">Conversation body</p>
    </article>
    <article data-testid="message-assistant">
      <section data-testid="assistant-plan-card">
        <p data-scroll-anchor style="line-height: 20px">Compact plan preview</p>
      </section>
    </article>`
  document.body.append(list)
  const bodyTypography = readMessageLayoutTypography(list)

  list.firstElementChild!.remove()
  expect(readMessageLayoutTypography(list)).toEqual(bodyTypography)

  list.replaceChildren()
  expect(readMessageLayoutTypography(list)).toEqual(bodyTypography)
})
