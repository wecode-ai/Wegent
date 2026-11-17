import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDevtoolsClient } from '../../../scripts/ai-verify-devtools.mjs'
import { getSingleElementMetrics } from './conversation-layout.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { DEFAULT_STEP_TIMEOUT_MS, resultDir } from './shared.mjs'

const readMetrics = (control, selector) => getSingleElementMetrics(control, selector, selector)

export async function waitForProjectCreateViewport(control, width = 1024, height = 768) {
  return waitForValue(
    () => readMetrics(control, 'body'),
    metrics => metrics?.viewportWidth === width && metrics.viewportHeight === height,
    `Project creation viewport did not resize to ${width}x${height}`,
    DEFAULT_STEP_TIMEOUT_MS
  )
}

export async function assertProjectCreateActionHit(control, selector) {
  await control.command('waitFor', selector, { visible: true })
  const metrics = await readMetrics(control, selector)
  if (!metrics?.hitTestVisible)
    await saveProjectCreateFocusEvidence('project-create-hit-failure', selector)
  assert.ok(
    metrics?.hitTestVisible,
    `Project creation action is covered: ${selector}; metrics=${JSON.stringify(metrics)}`
  )
  assert.ok(metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight)
  assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewportWidth)
}

export async function saveProjectCreateFocusEvidence(name, selector) {
  try {
    await collectProjectCreateFocusEvidence(name, selector)
  } catch (error) {
    console.error('Unable to capture project creation failure evidence', error)
  }
}

async function collectProjectCreateFocusEvidence(name, selector) {
  return withProjectRenderer(async (client, target) => {
    const evidence = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
        const describe = element => {
          if (!(element instanceof HTMLElement)) return null
          const style = getComputedStyle(element)
          return { tag: element.tagName, testId: element.dataset.testid, className: element.className,
            tabIndex: element.tabIndex, tabIndexAttribute: element.getAttribute('tabindex'),
            contentEditable: element.contentEditable, disabled: element.matches(':disabled'),
            hidden: Boolean(element.closest('[hidden],[inert],[aria-hidden="true"]')),
            display: style.display, visibility: style.visibility, position: style.position,
            zIndex: style.zIndex, transform: style.transform, opacity: style.opacity,
            isolation: style.isolation, contain: style.contain, filter: style.filter }
        }
        const ancestry = element => { const chain = []; while(element) { chain.push(describe(element)); element = element.parentElement } return chain }
        const scope = document.querySelector(${JSON.stringify(selector)})
        const rect = scope?.getBoundingClientRect()
        return { active: ancestry(document.activeElement), scope: ancestry(scope),
          hit: rect ? ancestry(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)) : null,
          controls: scope ? Array.from(scope.querySelectorAll('input,button,select,textarea,[contenteditable]')).map(describe) : [] }
      })()`,
      },
    })
    await writeFile(
      join(resultDir, `${name}.json`),
      JSON.stringify(evidence.result?.value, null, 2)
    )
  })
}

export async function withProjectRenderer(inspect) {
  const client = await createDevtoolsClient(resultDir, DEFAULT_STEP_TIMEOUT_MS)
  const target = (await client({ action: 'targets' })).find(
    entry =>
      entry.type === 'window' &&
      entry.url.includes('/wework/app/') &&
      !entry.url.includes('startup-splash')
  )?.id
  assert.ok(target, 'The isolated renderer must be available for project diagnostics')
  try {
    return await inspect(client, target)
  } finally {
    await client({ action: 'detach', target })
  }
}
