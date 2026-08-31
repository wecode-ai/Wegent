import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const BROWSER_LABEL_SELECTOR =
  `${ACTIVE_WORKBENCH_SELECTOR} ` +
  '[data-testid="desktop-workbench-content"][data-embedded-browser-label]'
const BROWSER_PANEL_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-panel"]`
const BROWSER_ANNOTATE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-annotate-button"]`
const BROWSER_ANNOTATION_CLOSE_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-annotation-close-button"]`
const BROWSER_ANNOTATION_COUNT_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-annotation-count"]`
const BROWSER_ANNOTATION_ORIGINAL_VIEW_SELECTOR =
  `${ACTIVE_WORKBENCH_SELECTOR} ` +
  '[data-testid="workspace-browser-annotation-original-view-button"]'
const COMPOSER_SELECTOR = '[data-testid="chat-message-input"][contenteditable="true"]'
const OVERLAY_WINDOW_LABEL = 'browser-annotation-overlay'
const OVERLAY_INPUT_SELECTOR = '[data-testid="browser-annotation-comment-input"]'
const OVERLAY_SUBMIT_SELECTOR = '[data-testid="browser-annotation-submit-button"]'
const OVERLAY_DELETE_SELECTOR = '[data-testid="browser-annotation-delete-button"]'
const OVERLAY_DESIGN_SELECTOR = '[data-testid="browser-annotation-design-button"]'
const OVERLAY_COLOR_SELECTOR = '[data-testid="browser-annotation-design-color"]'
const OVERLAY_FONT_SIZE_SELECTOR = '[data-testid="browser-annotation-design-font-size"]'
const OVERLAY_BACKGROUND_COLOR_SELECTOR =
  '[data-testid="browser-annotation-design-background-color"]'
const OVERLAY_SCREENSHOT_SELECTOR = '[data-testid="browser-annotation-screenshot-ready"]'
const MARKER_SELECTOR = '[data-wework-browser-annotation-marker]'
const INTERACTION_LAYER_SELECTOR = '[data-wework-browser-annotation-interaction-layer]'
const HOVER_SELECTOR = '[data-wework-browser-annotation-hover]'
const MARKER_ROOT_ID = '__wework_browser_annotation_root__'
const BRIDGE_RUNTIME_FILE = 'embedded-browser-bridge.json'
const FIXTURE_PATH = '/browser-annotation/basic'
const ANCHOR_FIXTURE_PATH = '/browser-annotation/anchors'
const DESIGN_FIXTURE_PATH = '/browser-annotation/design'
const SETUP_PROMPT =
  'WEWORK_DESKTOP_E2E_EMBEDDED_BROWSER_SETUP: create a local task before opening the browser.'
const SETUP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_EMBEDDED_BROWSER_SETUP_COMPLETE'

function selectedCheckpoint() {
  const segmentIndex = process.argv.indexOf('--segment')
  return segmentIndex >= 0 ? process.argv[segmentIndex + 1] : null
}

function basicFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser Annotation Core Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 48px; }
      button { display: block; margin-block: 16px; padding: 12px 18px; }
    </style>
  </head>
  <body>
    <h1>Browser Annotation Core Fixture</h1>
    <button id="annotation-primary" type="button" aria-label="Primary annotation target">
      Primary annotation target
    </button>
    <output id="page-click-state">not-clicked</output>
    <script>
      document.getElementById('annotation-primary').addEventListener('click', () => {
        document.getElementById('page-click-state').textContent = 'page-clicked';
      });
    </script>
  </body>
</html>`
}

function anchorFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser Annotation Anchor Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 48px; }
      button { margin: 8px; padding: 10px 14px; }
    </style>
  </head>
  <body>
    <h1>Browser Annotation Anchor Fixture</h1>
    <section id="replace-host">
      <button id="replace-target" type="button" aria-label="Replaceable target">
        Replaceable target
      </button>
    </section>
    <button id="replace-trigger" type="button">Replace target node</button>
    <div id="shadow-host"></div>
    <script>
      document.getElementById('replace-trigger').addEventListener('click', () => {
        const replacement = document.createElement('button');
        replacement.id = 'replace-target';
        replacement.type = 'button';
        replacement.setAttribute('aria-label', 'Replaceable target');
        replacement.textContent = 'Replaceable target';
        document.getElementById('replace-host').replaceChildren(replacement);
        document.body.dataset.replaced = 'true';
      });
      const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
      shadow.innerHTML =
        '<button id="shadow-target" type="button" aria-label="Shadow target">Shadow target</button>';
    </script>
  </body>
</html>`
}

function designFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser Annotation Design Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 48px; }
      #design-target {
        color: rgb(17, 24, 39);
        background: rgb(248, 250, 252);
        font-size: 16px;
        display: flex;
        gap: 4px;
        padding: 12px;
        border: 1px solid rgb(156, 163, 175);
      }
    </style>
  </head>
  <body>
    <h1>Browser Annotation Design Fixture</h1>
    <div id="design-host">
      <button id="design-target" type="button" aria-label="Design target">
        <span>Design</span><span>target</span>
      </button>
    </div>
    <button id="design-replace-trigger" type="button">Replace design target</button>
    <script>
      document.getElementById('design-replace-trigger').addEventListener('click', () => {
        const replacement = document.createElement('button');
        replacement.id = 'design-target';
        replacement.type = 'button';
        replacement.setAttribute('aria-label', 'Design target');
        replacement.innerHTML = '<span>Design</span><span>target</span>';
        document.getElementById('design-host').replaceChildren(replacement);
        document.body.dataset.designReplaced = 'true';
      });
    </script>
  </body>
</html>`
}

async function waitForBridgeIdentity(executorHome, timeoutMs) {
  const runtimePath = join(executorHome, 'runtime', BRIDGE_RUNTIME_FILE)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(runtimePath, 'utf8').catch(() => '')
    if (content) {
      const record = JSON.parse(content)
      if (record.schemaVersion === 1 && record.address && record.token) {
        return { baseUrl: `http://${record.address}`, token: record.token }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the embedded browser bridge runtime')
}

async function callBridge(identity, label, payload) {
  const response = await fetch(`${identity.baseUrl}/browser`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${identity.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label, ...payload }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, `Browser bridge HTTP failed: ${JSON.stringify(body)}`)
  assert.equal(body.ok, true, `Browser bridge action failed: ${JSON.stringify(body)}`)
  return body.data
}

async function waitForWindowCommand(control, windowLabel, action, selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await control.commandForWindow(windowLabel, action, selector, {
        ...options,
        timeoutMs: Math.min(timeoutMs, 2_000),
      })
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `Timed out waiting for ${windowLabel} ${selector}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

async function captureWindowScreenshot(control, resultDir, windowLabel, name) {
  const dataUrl = await control.commandForWindow(windowLabel, 'capture', 'body', {
    timeoutMs: 30_000,
  })
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), `${windowLabel} screenshot did not return PNG data`)
  await writeFile(join(resultDir, name), Buffer.from(dataUrl.slice(prefix.length), 'base64'))
}

async function waitForElementCount(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  let lastCount = null
  while (Date.now() - startedAt < timeoutMs) {
    lastCount = Number(await control.command('getElementCount', selector))
    if (lastCount === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}; expected=${expected}, actual=${lastCount}`)
}

async function browserAnnotationRuntimeRevision(control) {
  control.activateWindow('main')
  return Number(
    await control.command('getAttribute', BROWSER_PANEL_SELECTOR, {
      value: 'data-browser-annotation-runtime-revision',
    })
  )
}

async function waitForBrowserAnnotationRender(control, previousRevision, timeoutMs, message) {
  const startedAt = Date.now()
  let actual = previousRevision
  while (Date.now() - startedAt < timeoutMs) {
    actual = await browserAnnotationRuntimeRevision(control)
    if (actual > previousRevision) return actual
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${message}; previous=${previousRevision}, actual=${actual}`)
}

async function waitForAnnotationSave(control, previousRuntimeRevision, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const editorCount = Number(
      await control
        .commandForWindow(OVERLAY_WINDOW_LABEL, 'getElementCount', OVERLAY_INPUT_SELECTOR)
        .catch(() => 0)
    )
    if (editorCount > 0) {
      const errorCount = Number(
        await control
          .commandForWindow(
            OVERLAY_WINDOW_LABEL,
            'getElementCount',
            '[data-testid="browser-annotation-submit-error"]'
          )
          .catch(() => 0)
      )
      if (errorCount > 0) {
        const message = await control.commandForWindow(
          OVERLAY_WINDOW_LABEL,
          'getText',
          '[data-testid="browser-annotation-submit-error"]'
        )
        throw new Error(`Browser annotation submit failed: ${message}`)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
      continue
    }

    control.activateWindow('main')
    const count = Number(
      await control.command('getElementCount', BROWSER_ANNOTATION_COUNT_SELECTOR)
    )
    if (count > 0) {
      await control.command('waitFor', BROWSER_ANNOTATION_COUNT_SELECTOR, {
        text: '1',
        timeoutMs,
      })
      return waitForBrowserAnnotationRender(
        control,
        previousRuntimeRevision,
        timeoutMs,
        'Saving the annotation did not complete its page render'
      )
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Browser annotation submit did not close the editor or publish a comment')
}

async function setupBrowser(
  control,
  executorHome,
  fixtureUrl,
  uiTimeoutMs,
  modelResponseTimeoutMs
) {
  await ensureExperimentalFeaturesEnabled(control)
  control.setScenario('embedded_browser_setup')
  await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
  await selectE2EModel(control)
  await control.command('fill', COMPOSER_SELECTOR, { value: SETUP_PROMPT })
  await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: SETUP_COMPLETION_TEXT,
    timeoutMs: modelResponseTimeoutMs,
  })
  await control.command('waitFor', BROWSER_LABEL_SELECTOR, { timeoutMs: uiTimeoutMs })
  const browserLabel = await control.command('getAttribute', BROWSER_LABEL_SELECTOR, {
    value: 'data-embedded-browser-label',
  })
  assert.ok(browserLabel, 'The active workbench did not expose an embedded browser label')
  const bridgeIdentity = await waitForBridgeIdentity(executorHome, uiTimeoutMs)
  await callBridge(bridgeIdentity, browserLabel, {
    action: 'open',
    url: fixtureUrl,
    timeoutMs: 8_000,
  })
  return {
    bridge: payload => callBridge(bridgeIdentity, browserLabel, payload),
    browserLabel,
  }
}

async function enterElementAnnotationMode(control, bridge, uiTimeoutMs) {
  await control.command('waitFor', BROWSER_ANNOTATE_SELECTOR, {
    enabled: true,
    timeoutMs: uiTimeoutMs,
  })
  const previousRuntimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.command('click', BROWSER_ANNOTATE_SELECTOR)
  await control.command('waitFor', BROWSER_ANNOTATION_CLOSE_SELECTOR, {
    timeoutMs: uiTimeoutMs,
  })
  await waitForBrowserAnnotationRender(
    control,
    previousRuntimeRevision,
    uiTimeoutMs,
    'Starting annotation mode did not complete its page render'
  )
  assert.equal(
    await pageValue(
      bridge,
      `Boolean(document.getElementById(${JSON.stringify(MARKER_ROOT_ID)})?.shadowRoot)`
    ),
    true,
    'The browser annotation preload did not initialize its isolated marker root'
  )
  assert.equal(
    await pageValue(
      bridge,
      `(() => {
        const layer = document
          .getElementById(${JSON.stringify(MARKER_ROOT_ID)})
          ?.shadowRoot?.querySelector(${JSON.stringify(INTERACTION_LAYER_SELECTOR)})
        return layer ? getComputedStyle(layer).cursor : null
      })()`
    ),
    'crosshair',
    'Starting annotation mode did not expose the crosshair interaction layer'
  )
}

async function hoverElementAnnotationTarget(bridge, targetSelector, uiTimeoutMs) {
  const targetPoint = await pageValue(
    bridge,
    `(() => {
      const target = document.querySelector(${JSON.stringify(targetSelector)})
      if (!target) return null
      const rect = target.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`
  )
  assert.ok(targetPoint, `Could not locate ${targetSelector} for annotation hover`)
  assert.equal(
    await pageValue(
      bridge,
      `(() => {
        const layer = document
          .getElementById(${JSON.stringify(MARKER_ROOT_ID)})
          ?.shadowRoot?.querySelector(${JSON.stringify(INTERACTION_LAYER_SELECTOR)})
        if (!layer) return false
        layer.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            clientX: ${targetPoint.x},
            clientY: ${targetPoint.y},
            pointerType: 'mouse',
          })
        )
        return true
      })()`
    ),
    true,
    `Could not hover ${targetSelector} through the annotation interaction layer`
  )
  await waitForPageValue(
    bridge,
    `(() => {
      const hover = document
        .getElementById(${JSON.stringify(MARKER_ROOT_ID)})
        ?.shadowRoot?.querySelector(${JSON.stringify(HOVER_SELECTOR)})
      if (!hover) return null
      const style = getComputedStyle(hover)
      return (
        style.borderTopWidth === '2px' &&
        style.borderTopColor === 'rgb(0, 105, 251)' &&
        (style.backgroundColor === 'rgba(0, 105, 251, 0.03)' ||
          style.backgroundColor.includes('/ 0.03)'))
      )
    })()`,
    true,
    uiTimeoutMs,
    'Hovering an annotation target did not expose the ChatGPT-style blue selection layer'
  )
}

async function selectElementAnnotationTarget(control, bridge, targetSelector, uiTimeoutMs) {
  const targetPoint = await pageValue(
    bridge,
    `(() => {
      const target = document.querySelector(${JSON.stringify(targetSelector)})
      if (!target) return null
      const rect = target.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`
  )
  assert.ok(targetPoint, `Could not locate ${targetSelector} for annotation selection`)
  await selectElementAnnotationPoint(
    control,
    bridge,
    targetPoint,
    uiTimeoutMs,
    `Could not select ${targetSelector} through the annotation interaction layer`
  )
}

async function selectElementAnnotationPoint(control, bridge, targetPoint, uiTimeoutMs, message) {
  assert.equal(
    await pageValue(
      bridge,
      `(() => {
        const layer = document
          .getElementById(${JSON.stringify(MARKER_ROOT_ID)})
          ?.shadowRoot?.querySelector(${JSON.stringify(INTERACTION_LAYER_SELECTOR)})
        if (!layer) return false
        layer.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            clientX: ${targetPoint.x},
            clientY: ${targetPoint.y},
          })
        )
        return true
      })()`
    ),
    true,
    message
  )
  await waitForWindowCommand(control, OVERLAY_WINDOW_LABEL, 'waitFor', OVERLAY_INPUT_SELECTOR, {
    timeoutMs: uiTimeoutMs,
  })
  await waitForWindowCommand(
    control,
    OVERLAY_WINDOW_LABEL,
    'waitFor',
    OVERLAY_SCREENSHOT_SELECTOR,
    { timeoutMs: uiTimeoutMs }
  )
}

async function startElementAnnotation(control, bridge, targetSelector, uiTimeoutMs) {
  await enterElementAnnotationMode(control, bridge, uiTimeoutMs)
  await hoverElementAnnotationTarget(bridge, targetSelector, uiTimeoutMs)
  await selectElementAnnotationTarget(control, bridge, targetSelector, uiTimeoutMs)
}

async function submitOverlayComment(control, comment, uiTimeoutMs) {
  const previousRuntimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'fill', OVERLAY_INPUT_SELECTOR, {
    value: comment,
  })
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'click', OVERLAY_SUBMIT_SELECTOR)
  await waitForAnnotationSave(control, previousRuntimeRevision, uiTimeoutMs)
}

async function pageValue(bridge, expression) {
  const result = await bridge({ action: 'evaluate', expression, timeoutMs: 5_000 })
  assert.equal(result.ok, true, `Page evaluation failed: ${JSON.stringify(result)}`)
  return result.value
}

async function pageValueWithRuntimeDiagnostics(control, bridge, expression, previousRevision) {
  try {
    return await pageValue(bridge, expression)
  } catch (error) {
    const actualRevision = await browserAnnotationRuntimeRevision(control).catch(() => null)
    throw new Error(
      `${
        error instanceof Error ? error.message : String(error)
      }; annotationRuntimeRevision=${previousRevision}->${String(actualRevision)}`
    )
  }
}

async function waitForPageValue(bridge, expression, expected, timeoutMs, message) {
  const startedAt = Date.now()
  let actual = null
  while (Date.now() - startedAt < timeoutMs) {
    actual = await pageValue(bridge, expression)
    if (actual === expected) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const diagnostics = await pageValue(
    bridge,
    `(() => {
      const target = document.querySelector('#design-target')
      const root = document.getElementById(${JSON.stringify(MARKER_ROOT_ID)})
      return {
        actual: target ? getComputedStyle(target).color : null,
        designAttribute: target?.getAttribute('data-wework-browser-design') ?? null,
        designReplaced: document.body.dataset.designReplaced ?? null,
        markerCount: root?.shadowRoot?.querySelectorAll(${JSON.stringify(MARKER_SELECTOR)}).length ?? 0,
        styleRules: Array.from(document.querySelectorAll('style[data-wework-browser-design-style]'))
          .map(style => ({ disabled: style.disabled, text: style.textContent })),
      }
    })()`
  )
  assert.equal(actual, expected, `${message}; diagnostics=${JSON.stringify(diagnostics)}`)
}

async function markerState(bridge) {
  return pageValue(
    bridge,
    `(() => {
      const marker = document.getElementById(${JSON.stringify(
        MARKER_ROOT_ID
      )})?.shadowRoot?.querySelector(${JSON.stringify(MARKER_SELECTOR)})
      if (!marker) return null
      const rect = marker.getBoundingClientRect()
      return {
        number: marker.textContent,
        id: marker.getAttribute('data-annotation-id'),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      }
    })()`
  )
}

async function clickMarker(bridge) {
  const marker = await markerState(bridge)
  assert.ok(marker, 'The browser annotation marker is unavailable')
  const result = await bridge({
    action: 'click',
    x: marker.x,
    y: marker.y,
    timeoutMs: 5_000,
  })
  assert.equal(
    result.ok,
    true,
    `The browser annotation marker could not be clicked: ${JSON.stringify(result)}`
  )
}

async function verifyCore(
  control,
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
  resultDir
) {
  const fixtureUrl = `${control.url}${FIXTURE_PATH}`
  const { bridge } = await setupBrowser(
    control,
    executorHome,
    fixtureUrl,
    uiTimeoutMs,
    modelResponseTimeoutMs
  )
  await bridge({
    action: 'waitFor',
    options: { condition: { textVisible: 'Browser Annotation Core Fixture' } },
    timeoutMs: 5_000,
  })

  await enterElementAnnotationMode(control, bridge, uiTimeoutMs)
  await hoverElementAnnotationTarget(bridge, '#annotation-primary', uiTimeoutMs)
  control.activateWindow('main')
  await captureScreenshot(control, 'browser-annotation-01-mode-active.png')
  await selectElementAnnotationTarget(control, bridge, '#annotation-primary', uiTimeoutMs)
  await captureWindowScreenshot(
    control,
    resultDir,
    OVERLAY_WINDOW_LABEL,
    'browser-annotation-02-comment-card.png'
  )
  assert.equal(
    await pageValue(
      bridge,
      `Boolean(document.querySelector('[data-testid="browser-annotation-comment-input"]'))`
    ),
    false,
    'The comment editor was mounted inside the annotated page'
  )
  assert.equal(
    await pageValue(bridge, `document.querySelector('#page-click-state')?.textContent`),
    'not-clicked',
    'Selecting a target triggered the page action'
  )
  await submitOverlayComment(control, 'Primary browser annotation comment', uiTimeoutMs)

  const savedMarker = await markerState(bridge)
  assert.equal(savedMarker?.number, '1', 'The first saved comment did not render marker 1')
  assert.ok(savedMarker?.id, 'The saved marker did not expose its comment identity')
  await captureScreenshot(control, 'browser-annotation-03-published-marker.png')

  await clickMarker(bridge)
  await waitForWindowCommand(control, OVERLAY_WINDOW_LABEL, 'waitFor', OVERLAY_INPUT_SELECTOR, {
    timeoutMs: uiTimeoutMs,
  })
  await captureWindowScreenshot(
    control,
    resultDir,
    OVERLAY_WINDOW_LABEL,
    'browser-annotation-04-edit-card.png'
  )
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'fill', OVERLAY_INPUT_SELECTOR, {
    value: 'Edited browser annotation comment',
  })
  const editRuntimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'click', OVERLAY_SUBMIT_SELECTOR)
  await waitForAnnotationSave(control, editRuntimeRevision, uiTimeoutMs)

  await clickMarker(bridge)
  await waitForWindowCommand(control, OVERLAY_WINDOW_LABEL, 'waitFor', OVERLAY_DELETE_SELECTOR, {
    timeoutMs: uiTimeoutMs,
  })
  const deleteRuntimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'click', OVERLAY_DELETE_SELECTOR)
  control.activateWindow('main')
  await waitForElementCount(
    control,
    BROWSER_ANNOTATION_COUNT_SELECTOR,
    0,
    uiTimeoutMs,
    'Deleting the comment did not clear the toolbar count'
  )
  await waitForBrowserAnnotationRender(
    control,
    deleteRuntimeRevision,
    uiTimeoutMs,
    'Deleting the annotation did not complete its page render'
  )
  assert.equal(
    await pageValue(
      bridge,
      `document.getElementById(${JSON.stringify(
        MARKER_ROOT_ID
      )})?.shadowRoot?.querySelectorAll(${JSON.stringify(MARKER_SELECTOR)}).length ?? 0`
    ),
    0,
    'Deleting the comment left a marker in the page'
  )
  await captureScreenshot(control, 'browser-annotation-07-deleted-and-exited.png')
}

async function verifyAnchors(control, executorHome, uiTimeoutMs, modelResponseTimeoutMs) {
  const fixtureUrl = `${control.url}${ANCHOR_FIXTURE_PATH}`
  const { bridge } = await setupBrowser(
    control,
    executorHome,
    fixtureUrl,
    uiTimeoutMs,
    modelResponseTimeoutMs
  )
  await bridge({
    action: 'waitFor',
    options: { condition: { textVisible: 'Browser Annotation Anchor Fixture' } },
    timeoutMs: 5_000,
  })

  await startElementAnnotation(control, bridge, '#replace-target', uiTimeoutMs)
  await submitOverlayComment(control, 'Keep this comment attached after replacement', uiTimeoutMs)
  const originalMarkerId = (await markerState(bridge))?.id
  assert.ok(originalMarkerId, 'The replaceable target did not receive a marker')

  let runtimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.command('click', BROWSER_ANNOTATION_CLOSE_SELECTOR)
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Stopping annotation mode did not complete its page render'
  )
  await bridge({ action: 'click', selector: '#replace-trigger', timeoutMs: 5_000 })
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Replacing the anchor target did not complete its page render'
  )
  assert.equal(
    await pageValue(bridge, `document.body.dataset.replaced`),
    'true',
    'The fixture did not replace the target node'
  )
  await control.command('click', BROWSER_ANNOTATE_SELECTOR)
  await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Restarting annotation mode did not complete its page render'
  )
  await control.command('waitFor', BROWSER_ANNOTATION_CLOSE_SELECTOR, {
    timeoutMs: uiTimeoutMs,
  })
  const restoredMarkerId = (await markerState(bridge))?.id
  assert.equal(
    restoredMarkerId,
    originalMarkerId,
    'DOM replacement changed the comment identity or lost its marker'
  )

  runtimeRevision = await browserAnnotationRuntimeRevision(control)
  await bridge({ action: 'reload', timeoutMs: 5_000 })
  await bridge({
    action: 'waitFor',
    options: { condition: { textVisible: 'Browser Annotation Anchor Fixture' } },
    timeoutMs: 5_000,
  })
  await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Reloading the annotated page did not complete its page render'
  )
  await control.command('waitFor', BROWSER_ANNOTATION_COUNT_SELECTOR, {
    text: '1',
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    (await markerState(bridge))?.id,
    originalMarkerId,
    'Reloading the same URL did not restore the persisted anchor'
  )

  runtimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.command('click', BROWSER_ANNOTATION_CLOSE_SELECTOR)
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Stopping annotation mode before the ShadowRoot check did not complete its page render'
  )
  await control.command('click', BROWSER_ANNOTATE_SELECTOR)
  await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Starting annotation mode before the ShadowRoot check did not complete its page render'
  )
  const shadowRect = await pageValue(
    bridge,
    `(() => {
      const target = document.querySelector('#shadow-host')?.shadowRoot?.querySelector('#shadow-target')
      if (!target) return null
      const rect = target.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`
  )
  assert.ok(shadowRect, 'The fixture shadow target is unavailable')
  await selectElementAnnotationPoint(
    control,
    bridge,
    shadowRect,
    uiTimeoutMs,
    'The open ShadowRoot target could not be selected through the annotation interaction layer'
  )
}

async function verifyDesign(
  control,
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
  resultDir
) {
  const fixtureUrl = `${control.url}${DESIGN_FIXTURE_PATH}`
  const { bridge } = await setupBrowser(
    control,
    executorHome,
    fixtureUrl,
    uiTimeoutMs,
    modelResponseTimeoutMs
  )
  await bridge({
    action: 'waitFor',
    options: { condition: { textVisible: 'Browser Annotation Design Fixture' } },
    timeoutMs: 5_000,
  })

  await startElementAnnotation(control, bridge, '#design-target', uiTimeoutMs)
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'fill', OVERLAY_INPUT_SELECTOR, {
    value: 'Use the requested design color',
  })
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'click', OVERLAY_DESIGN_SELECTOR)
  assert.equal(
    await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'getValue', OVERLAY_FONT_SIZE_SELECTOR),
    '16px',
    'The design editor did not show the target computed font size'
  )
  assert.equal(
    await control.commandForWindow(
      OVERLAY_WINDOW_LABEL,
      'getValue',
      OVERLAY_BACKGROUND_COLOR_SELECTOR
    ),
    '#f8fafc',
    'The design editor did not normalize the target computed background color'
  )
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'fill', OVERLAY_COLOR_SELECTOR, {
    value: '#ef4444',
  })
  await waitForWindowCommand(
    control,
    OVERLAY_WINDOW_LABEL,
    'waitFor',
    OVERLAY_SCREENSHOT_SELECTOR,
    { timeoutMs: uiTimeoutMs }
  )
  assert.equal(
    await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'getValue', OVERLAY_INPUT_SELECTOR),
    'Use the requested design color',
    'The controlled comment input lost its value before submit'
  )
  assert.equal(
    await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'getValue', OVERLAY_COLOR_SELECTOR),
    '#ef4444',
    'The controlled design input lost its value before submit'
  )
  await captureWindowScreenshot(
    control,
    resultDir,
    OVERLAY_WINDOW_LABEL,
    'browser-annotation-05-design-editor.png'
  )
  let runtimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.commandForWindow(OVERLAY_WINDOW_LABEL, 'click', OVERLAY_SUBMIT_SELECTOR)
  runtimeRevision = await waitForAnnotationSave(control, runtimeRevision, uiTimeoutMs)

  await waitForPageValue(
    bridge,
    `getComputedStyle(document.querySelector('#design-target')).color`,
    'rgb(239, 68, 68)',
    uiTimeoutMs,
    'The design change did not update the target computed style'
  )
  await captureScreenshot(control, 'browser-annotation-05b-design-applied.png')
  runtimeRevision = await browserAnnotationRuntimeRevision(control)
  await control.command('pointerDownOnly', BROWSER_ANNOTATION_ORIGINAL_VIEW_SELECTOR)
  await control.command('waitFor', BROWSER_ANNOTATION_ORIGINAL_VIEW_SELECTOR, {
    attribute: 'aria-pressed',
    value: 'true',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', BROWSER_PANEL_SELECTOR, {
    attribute: 'data-browser-annotation-original-view',
    value: 'true',
    timeoutMs: uiTimeoutMs,
  })
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Holding Original View did not complete its page render'
  )
  assert.equal(
    await pageValueWithRuntimeDiagnostics(
      control,
      bridge,
      `getComputedStyle(document.querySelector('#design-target')).color`,
      runtimeRevision
    ),
    'rgb(17, 24, 39)',
    'Original View did not restore the target color'
  )
  await captureScreenshot(control, 'browser-annotation-06-original-view.png')
  await control.command('pointerUp', BROWSER_ANNOTATION_ORIGINAL_VIEW_SELECTOR)
  await control.command('waitFor', BROWSER_ANNOTATION_ORIGINAL_VIEW_SELECTOR, {
    attribute: 'aria-pressed',
    value: 'false',
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', BROWSER_PANEL_SELECTOR, {
    attribute: 'data-browser-annotation-original-view',
    value: 'false',
    timeoutMs: uiTimeoutMs,
  })
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Releasing Original View did not complete its page render'
  )
  assert.equal(
    await pageValueWithRuntimeDiagnostics(
      control,
      bridge,
      `getComputedStyle(document.querySelector('#design-target')).color`,
      runtimeRevision
    ),
    'rgb(239, 68, 68)',
    'Releasing Original View did not replay the design change'
  )

  await control.command('click', BROWSER_ANNOTATION_CLOSE_SELECTOR)
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Stopping annotation mode before design rebind did not complete its page render'
  )
  await bridge({ action: 'click', selector: '#design-replace-trigger', timeoutMs: 5_000 })
  runtimeRevision = await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Replacing the design target did not complete its page render'
  )
  assert.equal(
    await pageValue(bridge, `document.body.dataset.designReplaced`),
    'true',
    'The design replacement fixture did not replace its target'
  )
  await control.command('click', BROWSER_ANNOTATE_SELECTOR)
  await waitForBrowserAnnotationRender(
    control,
    runtimeRevision,
    uiTimeoutMs,
    'Restarting annotation mode after design rebind did not complete its page render'
  )
  await waitForPageValue(
    bridge,
    `getComputedStyle(document.querySelector('#design-target')).color`,
    'rgb(239, 68, 68)',
    uiTimeoutMs,
    'Replacing the target node lost its persisted design change'
  )
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  modelResponseTimeoutMs,
  resultDir,
  uiTimeoutMs,
}) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET') return false
      const fixtures = {
        [FIXTURE_PATH]: basicFixtureHtml,
        [ANCHOR_FIXTURE_PATH]: anchorFixtureHtml,
        [DESIGN_FIXTURE_PATH]: designFixtureHtml,
      }
      const fixture = fixtures[url.pathname]
      if (!fixture) return false
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fixture())
      return true
    },

    async verify(control) {
      const checkpoint = selectedCheckpoint()
      if (checkpoint === 'browser-annotation-core') {
        await verifyCore(
          control,
          executorHome,
          uiTimeoutMs,
          modelResponseTimeoutMs,
          captureScreenshot,
          resultDir
        )
        return
      }
      if (checkpoint === 'browser-annotation-anchors') {
        await verifyAnchors(control, executorHome, uiTimeoutMs, modelResponseTimeoutMs)
        return
      }
      if (checkpoint === 'browser-annotation-design') {
        await verifyDesign(
          control,
          executorHome,
          uiTimeoutMs,
          modelResponseTimeoutMs,
          captureScreenshot,
          resultDir
        )
        return
      }
      throw new Error(`Unsupported browser annotation checkpoint: ${checkpoint}`)
    },
  }
}
