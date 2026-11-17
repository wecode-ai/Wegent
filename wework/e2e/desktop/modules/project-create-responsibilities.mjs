import assert from 'node:assert/strict'
import { withProjectRenderer } from './project-create-test-utils.mjs'

const EDITOR_ROW = '.collaboration-group-roster-item:nth-child(2)'
const SUMMARY_ROW = '.collaboration-project-create-group-members > span:nth-child(2)'

export const LONG_RESPONSIBILITY_URL = `https://example.invalid/${'LongResponsibilityBoundary'.repeat(14)}`

export async function assertSavedGroupResponsibility(control, summary, expected) {
  const selector = `${summary} ${SUMMARY_ROW} small`
  await control.command('scrollIntoView', selector)
  const metrics = await withProjectRenderer(async (client, target) => {
    const result = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const text = document.querySelector(${JSON.stringify(selector)})
          if (!text) return null
          const row = text.closest(${JSON.stringify(SUMMARY_ROW)})
          const summary = text.closest('[data-testid="collaboration-project-create-group-summary"]')
          const modal = text.closest('[role="dialog"]')
          const body = modal.querySelector('.collaboration-project-create-body')
          const describe = element => {
            const rect = element.getBoundingClientRect()
            return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
              left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
              width: rect.width }
          }
          const range = document.createRange()
          range.selectNodeContents(text)
          return { text: text.textContent, textBounds: describe(text), row: describe(row), summary: describe(summary),
            modal: describe(modal), body: describe(body), viewportWidth: innerWidth,
            lines: Array.from(range.getClientRects(), rect => ({
              left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom
            })).filter(rect => rect.width > 0) }
        })()`,
      },
    })
    return result.result?.value
  })
  assert.equal(metrics?.text, expected, 'The summary must preserve the complete responsibility')
  for (const name of ['row', 'summary', 'body', 'modal']) {
    const box = metrics[name]
    assert.ok(
      box.scrollWidth <= box.clientWidth + 1,
      `The saved responsibility overflowed its ${name}: ${JSON.stringify(metrics)}`
    )
  }
  assert.ok(metrics.modal.left >= 0 && metrics.modal.right <= metrics.viewportWidth)
  assert.ok(
    metrics.row.left >= metrics.summary.left && metrics.row.right <= metrics.summary.right + 1,
    `The responsibility row escaped its summary: ${JSON.stringify(metrics)}`
  )
  assert.ok(metrics.lines.length > expected.split('\n').length, 'The long URL must wrap')
  assert.ok(
    metrics.lines.every(
      line =>
        line.left >= metrics.row.left - 1 &&
        line.right <= metrics.row.right + 1 &&
        line.top >= metrics.textBounds.top - 1 &&
        line.bottom <= metrics.textBounds.bottom + 1
    ),
    `Responsibility text must remain readable within its row, without clipping: ${JSON.stringify(metrics)}`
  )
}

export async function assertReopenedGroupResponsibility(control, configuration, expected) {
  const responsibility = `${configuration} ${EDITOR_ROW} .collaboration-project-create-responsibility`
  const edit = `${responsibility} button`
  await control.command('scrollIntoView', edit)
  await control.command('nativePress', edit, { key: 'Enter' })
  const input = `${responsibility} textarea`
  await control.command('waitFor', input, { visible: true })
  assert.equal(
    await control.command('getValue', input),
    expected,
    'Reopening must preserve the complete responsibility including the long URL'
  )
  await control.command('nativePress', input, { key: 'Escape' })
  await control.command('waitFor', input, { visible: false })
}
