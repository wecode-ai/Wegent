import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDevtoolsClient } from '../../../scripts/ai-verify-devtools.mjs'
import {
  DEFAULT_STEP_TIMEOUT_MS,
  FILE_PREVIEW_RESTORE_MARKER,
  GIT_SEED_NAME,
  REVIEW_RESTORE_MARKER,
} from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const FONT_FIXTURE_LINE_PREFIX = 'Live font fixture'

async function withReviewCleanup(verify, cleanupSteps) {
  let failed = false
  try {
    return await verify()
  } catch (error) {
    failed = true
    throw error
  } finally {
    const errors = []
    for (const [label, cleanup] of cleanupSteps) {
      try {
        await cleanup()
      } catch (error) {
        console.error(`[workspace-review] ${label} cleanup failed:`, error)
        errors.push(error)
      }
    }
    if (!failed && errors.length)
      throw new AggregateError(errors, 'Workspace review cleanup failed')
  }
}

async function verifyUnchangedRefresh({
  renderer,
  detach,
  reviewLinesSelector,
  clickRefresh,
  waitForReviewLine,
}) {
  let previousReviewId
  await withReviewCleanup(async () => {
    const previousReview = await renderer('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(reviewLinesSelector)})`,
    })
    previousReviewId = previousReview.result.objectId
    assert.ok(previousReviewId, 'Missing the original loaded Diff view')
    await clickRefresh()
    const replaced = await renderer('Runtime.callFunctionOn', {
      objectId: previousReviewId,
      functionDeclaration: `function (timeout) {
          if (!this.isConnected) return true
          return new Promise(resolve => {
            const finish = replaced => {
              observer.disconnect()
              clearTimeout(timer)
              resolve(replaced)
            }
            const observer = new MutationObserver(() => {
              if (!this.isConnected) finish(true)
            })
            observer.observe(document, { childList: true, subtree: true })
            const timer = setTimeout(() => finish(false), timeout)
          })
        }`,
      arguments: [{ value: DEFAULT_STEP_TIMEOUT_MS }],
      awaitPromise: true,
      returnByValue: true,
    })
    assert.equal(replaced.result?.value, true, 'Unchanged review refresh did not reload the Diff')
    const unchangedReview = await waitForReviewLine(REVIEW_RESTORE_MARKER)
    assert.ok(unchangedReview.includes(FILE_PREVIEW_RESTORE_MARKER))
  }, [
    [
      'release original Diff',
      async () => {
        if (previousReviewId)
          await renderer('Runtime.releaseObject', { objectId: previousReviewId })
      },
    ],
    ['detach renderer', detach],
  ])
}

async function readDiffGeometry(renderer, diffContainerId, expected = null) {
  const result = await renderer('Runtime.callFunctionOn', {
    objectId: diffContainerId,
    functionDeclaration: `function (expected, timeout) {
      const read = () => {
        if (!this.isConnected) return { connected: false }
        const body = this.closest('[data-testid="file-changes-review-file-diff-body"]')
        const scroller = body.closest('.scrollbar-soft')
        const rect = scroller.getBoundingClientRect()
        const top = rect.top + scroller.clientTop
        const lines = [...this.shadowRoot.querySelectorAll('[data-line][data-line-index]')]
          .map(line => {
            const bounds = line.getBoundingClientRect()
            return { index: line.dataset.lineIndex, text: line.textContent, offset: bounds.top - top, height: bounds.height }
          })
        const visible = lines.filter(line => line.offset + line.height > 0 && line.offset < scroller.clientHeight)
        const anchor = expected?.anchor
          ? lines.find(line => line.index === expected.anchor.index && line.text === expected.anchor.text)
          : visible.find(line => line.offset >= 0)
        return {
          connected: this.isConnected,
          font: parseFloat(getComputedStyle(this).getPropertyValue('--text-code')),
          bodyHeight: body?.getBoundingClientRect().height,
          renderedRows: lines.length,
          visibleRows: visible.length,
          anchor,
          scrollTop: scroller.scrollTop,
          max: scroller.scrollHeight - scroller.clientHeight,
          viewportHeight: scroller.clientHeight,
          x: rect.left + scroller.clientWidth / 2,
          y: top + Math.min(200, scroller.clientHeight / 2)
        }
      }
      if (expected === null) return read()
      return new Promise(resolve => {
        let frame, last, previous, stable = 0
        const finish = converged => {
          cancelAnimationFrame(frame)
          clearTimeout(timer)
          resolve({ geometry: last, converged })
        }
        const timer = setTimeout(() => finish(false), timeout)
        const check = () => {
          last = read()
          const ready = last.connected && last.visibleRows > 0 && last.anchor &&
            (expected.middle
              ? last.scrollTop > last.viewportHeight && last.scrollTop < last.max - last.viewportHeight / 4
              : last.font === expected.font &&
                Math.abs(last.anchor.height - Math.round(expected.font * 1.8)) <= 1 &&
                Math.abs(last.bodyHeight - expected.bodyHeight) <= 3 &&
                Math.abs(last.anchor.offset - expected.anchor.offset) <= 2)
          const fingerprint = JSON.stringify(last)
          stable = ready && fingerprint === previous ? stable + 1 : 0
          previous = fingerprint
          if (stable >= 2) finish(true)
          else frame = requestAnimationFrame(check)
        }
        check()
      })
    }`,
    arguments: [{ value: expected }, { value: DEFAULT_STEP_TIMEOUT_MS }],
    awaitPromise: true,
    returnByValue: true,
  })
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  const sample = result.result.value
  if (expected === null) return sample
  assert.ok(
    sample?.converged,
    `Diff geometry did not converge: ${JSON.stringify({ expected, sample })}`
  )
  return sample.geometry
}

async function activateFontAction(control, action) {
  assert.equal(
    JSON.parse(
      await control.command('activateApplicationMenu', 'body', {
        value: JSON.stringify({ id: `view.${action}` }),
      })
    ),
    true,
    'The native font-size action did not activate'
  )
}

async function verifyLiveFontRoundTrip({
  control,
  renderer,
  detach,
  reviewLinesSelector,
  expectedRows,
}) {
  let diffContainerId
  let originalFont
  const readFont = async () => {
    const font = Number.parseFloat(
      await control.command('getComputedStyleValue', 'html', { value: '--text-code' })
    )
    assert.ok(Number.isInteger(font), 'The renderer did not report its code font size')
    return font
  }
  const changeNativeFont = async (action, expectedFont) => {
    await activateFontAction(control, action)
    await waitForValue(
      readFont,
      font => font === expectedFont,
      'The native font-size action did not update the renderer',
      DEFAULT_STEP_TIMEOUT_MS
    )
  }
  await withReviewCleanup(async () => {
    const container = await renderer('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(reviewLinesSelector + ' [data-review-path="' + GIT_SEED_NAME + '"] diffs-container')})`,
    })
    diffContainerId = container.result.objectId
    assert.ok(diffContainerId, 'Missing the actual large Diff renderer')
    const readGeometry = expected => readDiffGeometry(renderer, diffContainerId, expected)
    const topViewport = await readGeometry()
    assert.ok(topViewport.max > 2 * topViewport.viewportHeight, 'The large Diff did not overflow')
    await renderer('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: topViewport.x,
      y: topViewport.y,
      deltaX: 0,
      deltaY: Math.floor(topViewport.max / 2) - topViewport.scrollTop,
    })
    const beforeFont = await readGeometry({ middle: true })
    assert.ok(
      beforeFont.anchor &&
        beforeFont.visibleRows > 0 &&
        beforeFont.scrollTop > beforeFont.viewportHeight &&
        beforeFont.scrollTop < beforeFont.max - beforeFont.viewportHeight / 4,
      'Native wheel did not reach the middle of the large Diff'
    )
    assert.ok(
      beforeFont.renderedRows > 0 &&
        beforeFont.renderedRows < expectedRows &&
        Math.abs(beforeFont.anchor.height - Math.round(beforeFont.font * 1.8)) <= 1,
      'The live font fixture did not exercise Diff row virtualization'
    )
    const rendererFont = await readFont()
    assert.equal(rendererFont, beforeFont.font, 'The Diff did not use the renderer code font')
    originalFont = rendererFont
    const changeFont = async (action, font, expectedHeight) => {
      await changeNativeFont(action, font)
      const geometry = await readGeometry({
        font,
        bodyHeight: expectedHeight,
        anchor: beforeFont.anchor,
      })
      assert.ok(
        geometry.connected &&
          geometry.font === font &&
          geometry.anchor?.index === beforeFont.anchor.index &&
          geometry.anchor.text === beforeFont.anchor.text &&
          Math.abs(geometry.anchor.height - Math.round(font * 1.8)) <= 1 &&
          Math.abs(geometry.anchor.offset - beforeFont.anchor.offset) <= 2 &&
          geometry.visibleRows > 0 &&
          Math.abs(geometry.bodyHeight - expectedHeight) <= 3,
        `The existing Diff did not update all virtual row heights and preserve its reader line: ${JSON.stringify({ geometry, expectedHeight })}`
      )
      assert.ok(geometry.renderedRows > 0 && geometry.renderedRows < expectedRows)
    }
    const largerFont = beforeFont.font + 1
    const heightDelta =
      expectedRows * (Math.round(largerFont * 1.8) - Math.round(beforeFont.font * 1.8))
    await changeFont('increaseFontSize', largerFont, beforeFont.bodyHeight + heightDelta)
    await changeFont('decreaseFontSize', beforeFont.font, beforeFont.bodyHeight)
  }, [
    [
      'restore font',
      async () => {
        if (originalFont === undefined) return
        const font = await readFont()
        if (font === originalFont) return
        assert.equal(Math.abs(font - originalFont), 1, 'Unexpected font size after a single step')
        await changeNativeFont(
          font > originalFont ? 'decreaseFontSize' : 'increaseFontSize',
          originalFont
        )
      },
    ],
    [
      'release large Diff',
      async () => {
        if (diffContainerId) await renderer('Runtime.releaseObject', { objectId: diffContainerId })
      },
    ],
    ['detach renderer', detach],
  ])
}

export async function verifyWorkspaceReviewRefresh({
  control,
  resultDir,
  workspacePath,
  activeTaskWorkbenchSelector,
  setPhase,
}) {
  setPhase('workspace-review-refresh-content')
  const reviewLinesSelector = `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-diff-lines"]`
  const reviewRefreshSelector = `${activeTaskWorkbenchSelector} [data-testid="refresh-review-diff-button"]`
  const waitForReviewLine = (marker, includeOffscreen = false) =>
    control.command('waitFor', '[data-line]', {
      target: reviewLinesSelector,
      text: marker,
      visible: includeOffscreen ? undefined : true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  const reviewBodySelector = `${reviewLinesSelector} [data-review-path="${GIT_SEED_NAME}"] [data-testid="file-changes-review-file-diff-body"]`
  const readBodyHeight = async () =>
    JSON.parse(await control.command('getElementMetrics', reviewBodySelector))[0]?.height ?? 0
  const toolbarSelector = `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-toolbar"]`
  const readToolbar = () => control.command('getText', toolbarSelector)
  const clickRefresh = () =>
    control.command('clickWhenEnabled', reviewRefreshSelector, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  const refreshReview = async marker => {
    await clickRefresh()
    return waitForReviewLine(marker)
  }
  await waitForReviewLine(REVIEW_RESTORE_MARKER)
  const originalBodyHeight = await readBodyHeight()
  assert.ok(originalBodyHeight > 0, 'The original Diff did not have a measured body')
  const devtools = await createDevtoolsClient(resultDir, DEFAULT_STEP_TIMEOUT_MS + 1000)
  const origin = await control.command('getLocationOrigin', 'body')
  const reviewTarget = (await devtools({ action: 'targets' })).find(
    target => target.type === 'window' && target.url.startsWith(origin + '/wework/app/')
  )?.id
  assert.ok(reviewTarget, 'Missing the actual workbench renderer for review inspection')
  const renderer = (method, params) =>
    devtools({ action: 'command', target: reviewTarget, method, params })
  const detach = () => devtools({ action: 'detach', target: reviewTarget })
  await verifyUnchangedRefresh({
    renderer,
    detach,
    reviewLinesSelector,
    clickRefresh,
    waitForReviewLine,
  })
  await waitForValue(
    readBodyHeight,
    height => height > 0 && Math.abs(height - originalBodyHeight) <= 3,
    'The unmodified Diff did not return to its original height after refresh',
    DEFAULT_STEP_TIMEOUT_MS
  )

  const readmePath = join(workspacePath, GIT_SEED_NAME)
  const originalReadme = await readFile(readmePath, 'utf8')
  const refreshedReviewMarker = 'WEWORK_DESKTOP_E2E_REVIEW_REFRESHED'
  assert.ok(originalReadme.includes(REVIEW_RESTORE_MARKER))
  await withReviewCleanup(async () => {
    await writeFile(
      readmePath,
      originalReadme.replace(REVIEW_RESTORE_MARKER, refreshedReviewMarker)
    )
    const changedReview = await refreshReview(refreshedReviewMarker)
    assert.ok(changedReview.includes(FILE_PREVIEW_RESTORE_MARKER))
    assert.ok(!changedReview.includes(REVIEW_RESTORE_MARKER), 'The review rendered stale code')
    assert.match(
      await readToolbar(),
      /\+2\s*-0/,
      'Changing content without changing the line count altered the review statistics'
    )

    setPhase('workspace-review-live-font')
    const extraLines = Array.from(
      { length: 480 },
      (_, index) => `${FONT_FIXTURE_LINE_PREFIX} ${index}`
    )
    await writeFile(readmePath, originalReadme + extraLines.join('\n') + '\n')
    await refreshReview(extraLines[0])
    const expectedRows = originalReadme.trimEnd().split('\n').length + extraLines.length
    await verifyLiveFontRoundTrip({ control, renderer, detach, reviewLinesSelector, expectedRows })
  }, [['restore README', () => writeFile(readmePath, originalReadme)]])
  setPhase('workspace-review-restore-refresh')
  await clickRefresh()
  const restoredStats = /\+2\s*-0(?!\d)/
  await waitForValue(
    readToolbar,
    text => restoredStats.test(text),
    'The restored review did not return the original Diff statistics',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await waitForReviewLine(REVIEW_RESTORE_MARKER)
  // Hidden virtual rows do not contribute text to the visible-line check.
  // The body height also verifies the full patch returned to its original size.
  await waitForValue(
    readBodyHeight,
    height => height > 0 && Math.abs(height - originalBodyHeight) <= 3,
    'The restored Diff did not return to its original height',
    DEFAULT_STEP_TIMEOUT_MS
  )
  const restoredReview = await waitForReviewLine(REVIEW_RESTORE_MARKER, true)
  assert.match(await readToolbar(), restoredStats, 'The restored Diff statistics changed')
  assert.ok(!restoredReview.includes(refreshedReviewMarker))
  assert.ok(
    !restoredReview.includes(FONT_FIXTURE_LINE_PREFIX),
    'The review retained large fixture rows'
  )
}
