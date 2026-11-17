import assert from 'node:assert/strict'
import { withProjectRenderer } from './project-create-test-utils.mjs'

const SECTION = '[data-testid="collaboration-project-create-group-instructions"]'
const EDIT = `${SECTION} .collaboration-project-create-hover-editable > button`

export async function editGroupPrinciples(control, configuration, text) {
  await control.command('nativePress', `${configuration} ${EDIT}`, { key: 'Enter' })
  const input = `${configuration} ${SECTION} textarea`
  await control.command('waitFor', input, { visible: true })
  await control.command('fill', input, { value: text })
  await control.command('nativePress', input, { key: 'Escape' })
  await control.command('waitFor', input, { visible: false })
}

async function readPrincipleLines(selector, expected) {
  return withProjectRenderer(async (client, target) => {
    const value = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const paragraph = document.querySelector(${JSON.stringify(selector)})
          if (!paragraph) return null
          if (paragraph.textContent !== ${JSON.stringify(expected)}) return { text: paragraph.textContent }
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
          const textNodes = []
          while (walker.nextNode()) textNodes.push(walker.currentNode)
          const position = offset => {
            for (const node of textNodes) {
              if (offset <= node.textContent.length) return [node, offset]
              offset -= node.textContent.length
            }
            return null
          }
          let offset = 0
          const lines = ${JSON.stringify(expected.split('\n'))}.map(line => {
            const range = document.createRange()
            range.setStart(...position(offset))
            range.setEnd(...position(offset + line.length))
            offset += line.length + 1
            return Array.from(range.getClientRects(), rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
          })
          const style = getComputedStyle(paragraph)
          return { text: paragraph.textContent, lines, height: paragraph.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize),
            clientWidth: paragraph.clientWidth, scrollWidth: paragraph.scrollWidth }
        })()`,
      },
    })
    return value.result?.value
  })
}

export async function assertRenderedGroupPrinciples(control, summary, expected) {
  const paragraph = `${summary} .collaboration-project-create-group-principles p`
  await control.command('scrollIntoView', paragraph, { visible: true })
  const metrics = await readPrincipleLines(paragraph, expected)
  assert.equal(metrics?.text, expected, 'Saving must preserve the entered principle text')
  assert.ok(
    metrics.lines.every(rects => rects.length === 1),
    'Each short principle must occupy one line'
  )
  const lines = metrics.lines.map(rects => rects[0])
  assert.equal(
    new Set(lines.map(line => Math.round(line.y))).size,
    3,
    `Explicit principle breaks collapsed in the summary: ${JSON.stringify(metrics)}`
  )
  assert.ok(
    lines.reduce((width, line) => width + line.width, 0) + metrics.fontSize * 2 <
      metrics.clientWidth,
    'These short principles must fit on one line without explicit breaks, excluding natural wrapping'
  )
  assert.ok(Number.isFinite(metrics.lineHeight) && metrics.height >= metrics.lineHeight * 3 - 1)
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth,
    'Saved principles must not overflow horizontally'
  )
}

export async function assertReopenedGroupPrinciples(
  control,
  summary,
  configuration,
  expected,
  inspectConfiguration
) {
  await control.command(
    'nativePress',
    `${summary} [data-testid="collaboration-project-create-edit-group"]`,
    { key: 'Enter' }
  )
  await control.command('waitFor', configuration, { visible: true })
  if (inspectConfiguration) await inspectConfiguration()
  await control.command('nativePress', `${configuration} ${EDIT}`, { key: 'Enter' })
  const input = `${configuration} ${SECTION} textarea`
  await control.command('waitFor', input, { visible: true })
  assert.equal(
    await control.command('getValue', input),
    expected,
    'Reopening must retain the saved principle lines'
  )
  await control.command('nativePress', input, { key: 'Escape' })
  await control.command('waitFor', input, { visible: false })
  await control.command(
    'nativePress',
    `${configuration} [data-testid="collaboration-project-create-configuration-back"]`,
    { key: 'Escape' }
  )
  await control.command('waitFor', configuration, { visible: false })
}
