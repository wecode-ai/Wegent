import assert from 'node:assert/strict'
import { until } from './plugin-regression-fixture.mjs'

// The editor exposes block text and persistence returns markdown.
function descriptionText(value) {
  return value
    .replaceAll('\\_', '_')
    .split(/\r?\n/)
    .filter(line => line.trim())
    .join('\n')
}

/** Preceding content reflow must refresh a question's overlay exemption. */
export async function verifyIssueQuestionReflow(
  control,
  { contentScope, question, originalDescription, readDescription, captureScreenshot }
) {
  const scope = id => `${contentScope} [data-testid="${id}"]`
  const description = scope('cloud-todo-detail-description')
  const toggle = scope('issue-description-toggle')
  const viewport = scope('cloud-todo-detail-scroll')
  const composer = `${contentScope} .task-detail-comment-bar`
  const metrics = async () =>
    JSON.parse(
      await control.command('getElementMetrics', [viewport, question, composer].join(', '), {
        value: 'includeText',
      })
    )
  async function saveDescription(value) {
    const expected = descriptionText(value)
    await control.command('scrollIntoViewAsUser', scope('issue-description-edit'))
    await control.command('click', scope('issue-description-edit'))
    await control.command('waitFor', `${description}[contenteditable="true"]`, { visible: true })
    const existingText = await control.command('getText', description)
    if (existingText) {
      await control.command('selectText', description, { value: existingText })
    }
    await control.command('pasteText', description, { value })
    await until(
      () => control.command('getValue', description),
      draft => descriptionText(draft) === expected,
      'The Issue editor did not retain the complete pasted description'
    )
    await control.command('clickWhenEnabled', scope('cloud-todo-save'))
    await control.command('waitFor', scope('issue-save-status'), { text: '已保存' })
    await until(
      readDescription,
      saved => descriptionText(saved) === expected,
      'The persisted Issue description did not match the editor draft'
    )
  }
  await saveDescription(
    [
      originalDescription,
      ...Array.from(
        { length: 30 },
        (_, index) =>
          `第 ${index + 1} 段：补充人工问题的背景，验证展开内容后仍按实际可见范围安排评论框。`
      ),
    ].join('\n\n')
  )
  try {
    await control.command('scrollIntoViewAsUser', toggle)
    await control.command('waitFor', toggle, { visible: true })
    if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) === 'true')
      await control.command('click', toggle)
    await control.command('scrollIntoViewAsUser', toggle)
    await control.command('waitFor', `${composer}[data-human-request-visible="true"]`)
    const before = await metrics()
    const beforeViewport = before.find(row => row.testId === 'cloud-todo-detail-scroll')
    const beforeQuestion = before.find(row => row.testId?.startsWith('issue-human-request-'))
    assert.ok(
      beforeViewport && beforeQuestion,
      `Missing identified question geometry: ${JSON.stringify(before)}`
    )
    assert.ok(
      beforeQuestion.bottom > beforeViewport.top && beforeQuestion.top < beforeViewport.bottom,
      `The pending question must initially intersect the reading viewport: ${JSON.stringify(before)}`
    )
    await control.command('click', toggle)
    await control.command('waitFor', `${toggle}[aria-expanded="true"]`)
    await control.command('waitFor', `${composer}[data-human-request-visible="false"]`)
    const after = await metrics()
    const afterViewport = after.find(row => row.testId === 'cloud-todo-detail-scroll')
    const afterQuestion = after.find(row => row.testId?.startsWith('issue-human-request-'))
    assert.ok(
      afterViewport && afterQuestion,
      `Missing identified question geometry: ${JSON.stringify(after)}`
    )
    assert.ok(
      afterQuestion.top >= afterViewport.bottom,
      `Description expansion must move the question below the viewport: ${JSON.stringify(after)}`
    )
    assert.ok(
      Math.abs(afterViewport.scrollTop - beforeViewport.scrollTop) <= 1,
      `Reflow must be detected without a scroll event: ${JSON.stringify({ beforeViewport, afterViewport })}`
    )
    assert.equal(
      await control.command('getComputedStyleValue', composer, { value: 'position' }),
      'sticky'
    )
    const padding = Number.parseFloat(
      await control.command('getComputedStyleValue', viewport, { value: 'scroll-padding-bottom' })
    )
    const footprint = after.find(row => !row.testId)
    assert.ok(
      padding >= footprint.height + 15,
      `Sticky clearance must return after reflow: ${JSON.stringify({ padding, footprint })}`
    )
    await captureScreenshot(control, 'issue-handoff-question-description-reflow.png')
  } finally {
    await saveDescription(originalDescription)
  }
}
