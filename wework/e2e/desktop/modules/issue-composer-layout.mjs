import { assert, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

const FULLSCREEN_COLUMN_MAX_WIDTH_PX = 768
// Content scrolls independently from the footer, so a platform scrollbar can
// shift the content box by a few pixels even when both columns are aligned.
const COLUMN_EDGE_TOLERANCE_PX = 8

async function readElementMetrics(control, selector, description) {
  const [metrics] = JSON.parse(await control.command('getElementMetrics', selector))
  assert.ok(metrics, `${description} did not expose layout metrics`)
  return metrics
}

async function waitForCompactViewport(control) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let viewport
  do {
    viewport = await readElementMetrics(control, 'html', 'Compact viewport')
    if (viewport.clientWidth === 1024 && viewport.clientHeight === 600) return viewport
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  } while (Date.now() < deadline)
  assert.fail(`Viewport did not resize to 1024x600: ${JSON.stringify(viewport)}`)
}

export async function assertIssueComposerReachableInCompactWindow(
  control,
  { composerSelector, scrollSelector }
) {
  const previousWindowSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1024, height: 600 }),
  })
  try {
    const viewport = await waitForCompactViewport(control)
    await control.command('scrollToRatioAsUser', scrollSelector, { value: '0' })
    const before = await readElementMetrics(control, composerSelector, 'Issue composer')
    await control.command('scrollIntoView', composerSelector)
    await control.command('waitFor', composerSelector, {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const composer = await readElementMetrics(control, composerSelector, 'Issue composer')
    const scroller = await readElementMetrics(control, scrollSelector, 'Issue detail scroller')
    assert.ok(
      composer.top >= Math.max(0, scroller.top) &&
        composer.bottom <= Math.min(viewport.clientHeight, scroller.bottom) &&
        composer.left >= Math.max(0, scroller.left) &&
        composer.right <= Math.min(viewport.clientWidth, scroller.right),
      `Issue composer was not fully reachable after scrolling: ${JSON.stringify({
        viewport,
        scroller,
        composer,
      })}`
    )
    console.log('[task-activity-compact-scroll]', JSON.stringify({ before, composer, scroller }))
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousWindowSize })
  }
}

function assertColumnEdgesMatch(actual, expected, description) {
  assert.ok(
    Math.abs(actual.left - expected.left) <= COLUMN_EDGE_TOLERANCE_PX,
    `${description} left edge ${actual.left}px did not match the content column ${expected.left}px`
  )
  assert.ok(
    Math.abs(actual.right - expected.right) <= COLUMN_EDGE_TOLERANCE_PX,
    `${description} right edge ${actual.right}px did not match the content column ${expected.right}px`
  )
}

export async function assertFullscreenIssueComposerColumn(
  control,
  {
    contentSelector,
    footerSelector,
    optionsSelector,
    panelSelector,
    label = 'Fullscreen Issue composer',
  }
) {
  const content = await readElementMetrics(control, contentSelector, `${label} content`)
  const footer = await readElementMetrics(control, footerSelector, `${label} footer`)
  const options = optionsSelector
    ? await readElementMetrics(control, optionsSelector, `${label} create options`)
    : null
  const panel = panelSelector
    ? await readElementMetrics(control, panelSelector, `${label} panel`)
    : null
  const columns = [
    ['content', content],
    ['footer', footer],
    ...(options ? [['create options', options]] : []),
  ]

  for (const [name, metrics] of columns) {
    assert.ok(
      metrics.width <= FULLSCREEN_COLUMN_MAX_WIDTH_PX + 1,
      `${label} ${name} exceeded the reading column: ${metrics.width}px`
    )
  }
  assertColumnEdgesMatch(footer, content, `${label} footer`)
  if (options) {
    assertColumnEdgesMatch(options, content, `${label} create options`)
  }
  if (panel) {
    const contentCenter = (content.left + content.right) / 2
    const panelCenter = (panel.left + panel.right) / 2
    assert.ok(
      Math.abs(contentCenter - panelCenter) <= COLUMN_EDGE_TOLERANCE_PX,
      `${label} content was not centered in its panel: ${JSON.stringify({
        contentCenter,
        panelCenter,
      })}`
    )
  }

  return { content, footer, options }
}

export async function assertFullscreenIssueComposerColumnAtWindowSize(
  control,
  { windowSize, maxContentWidth, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, ...columnOptions }
) {
  const previousWindowSize = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify(windowSize),
    })
  )
  try {
    let content = null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      content = await readElementMetrics(
        control,
        columnOptions.contentSelector,
        `${columnOptions.label ?? 'Fullscreen Issue composer'} content`
      )
      if (content.width <= maxContentWidth) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    assert.ok(
      content && content.width <= maxContentWidth,
      `${columnOptions.label ?? 'Fullscreen Issue composer'} content did not shrink below ${maxContentWidth}px after resizing to ${windowSize.width}x${windowSize.height}: ${JSON.stringify(
        content
      )}`
    )
    return await assertFullscreenIssueComposerColumn(control, columnOptions)
  } finally {
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify(previousWindowSize),
    })
  }
}
