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
  const waitForReviewLine = marker =>
    control.command('waitFor', '[data-line]', {
      target: reviewLinesSelector,
      text: marker,
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  const refreshReview = async marker => {
    await control.command('clickWhenEnabled', reviewRefreshSelector, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    return waitForReviewLine(marker)
  }
  await waitForReviewLine(REVIEW_RESTORE_MARKER)
  const devtools = await createDevtoolsClient(resultDir, DEFAULT_STEP_TIMEOUT_MS + 1000)
  const origin = await control.command('getLocationOrigin', 'body')
  const reviewTarget = (await devtools({ action: 'targets' })).find(
    target => target.type === 'window' && target.url.startsWith(origin + '/wework/app/')
  )?.id
  assert.ok(reviewTarget, 'Missing the actual workbench renderer for review inspection')
  const renderer = (method, params) =>
    devtools({ action: 'command', target: reviewTarget, method, params })
  let previousReviewId
  try {
    const previousReview = await renderer('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(reviewLinesSelector)})`,
    })
    previousReviewId = previousReview.result.objectId
    assert.ok(previousReviewId, 'Missing the original loaded Diff view')
    await control.command('clickWhenEnabled', reviewRefreshSelector, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
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
  } finally {
    try {
      if (previousReviewId) await renderer('Runtime.releaseObject', { objectId: previousReviewId })
    } finally {
      await devtools({ action: 'detach', target: reviewTarget })
    }
  }

  const readmePath = join(workspacePath, GIT_SEED_NAME)
  const originalReadme = await readFile(readmePath, 'utf8')
  const refreshedReviewMarker = 'WEWORK_DESKTOP_E2E_REVIEW_REFRESHED'
  assert.ok(originalReadme.includes(REVIEW_RESTORE_MARKER))
  try {
    await writeFile(
      readmePath,
      originalReadme.replace(REVIEW_RESTORE_MARKER, refreshedReviewMarker)
    )
    const changedReview = await refreshReview(refreshedReviewMarker)
    assert.ok(changedReview.includes(FILE_PREVIEW_RESTORE_MARKER))
    assert.ok(!changedReview.includes(REVIEW_RESTORE_MARKER), 'The review rendered stale code')
    assert.match(
      await control.command(
        'getText',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-toolbar"]`
      ),
      /\+2\s*-0/,
      'Changing content without changing the line count altered the review statistics'
    )

    setPhase('workspace-review-live-font')
    const extraLines = Array.from({ length: 480 }, (_, index) => `Live font fixture ${index}`)
    await writeFile(readmePath, originalReadme + extraLines.join('\n') + '\n')
    await refreshReview(extraLines[0])
    const expectedRows = originalReadme.trimEnd().split('\n').length + extraLines.length
    let diffContainerId
    let fontIncreased = false
    try {
      const container = await renderer('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(reviewLinesSelector + ' [data-review-path="' + GIT_SEED_NAME + '"] diffs-container')})`,
      })
      diffContainerId = container.result.objectId
      assert.ok(diffContainerId, 'Missing the actual large Diff renderer')
      const readGeometry = async (expected = null) => {
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
              const finish = () => {
                cancelAnimationFrame(frame)
                clearTimeout(timer)
                resolve(last)
              }
              const timer = setTimeout(finish, timeout)
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
                if (stable >= 2) finish()
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
        return result.result.value
      }
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
      const changeFont = async (action, font, expectedHeight) => {
        assert.equal(
          JSON.parse(
            await control.command('activateApplicationMenu', 'body', {
              value: JSON.stringify({ id: `view.${action}` }),
            })
          ),
          true,
          'The native font-size action did not activate'
        )
        fontIncreased = action === 'increaseFontSize'
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
    } finally {
      try {
        if (fontIncreased) {
          await control.command('activateApplicationMenu', 'body', {
            value: JSON.stringify({ id: 'view.decreaseFontSize' }),
          })
        }
      } finally {
        try {
          if (diffContainerId)
            await renderer('Runtime.releaseObject', { objectId: diffContainerId })
        } finally {
          await devtools({ action: 'detach', target: reviewTarget })
        }
      }
    }
  } finally {
    await writeFile(readmePath, originalReadme)
  }
  const restoredReview = await refreshReview(REVIEW_RESTORE_MARKER)
  assert.ok(!restoredReview.includes(refreshedReviewMarker))
}
