import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  colorChannels,
  focusLayers,
  outlineContrast,
  readFocusPaint,
} from '../modules/focus-paint.mjs'
import {
  activateLinuxMainWindow,
  clickLinuxPointer,
  moveLinuxWindowPointer,
  moveWindowsWindowPointer,
} from '../modules/native-download-dialogs.mjs'
import { withProjectRenderer } from '../modules/project-create-test-utils.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../modules/shared.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const dialog = '[data-testid="runtime-task-close-confirm-overlay"] [role="dialog"]'
const quitButton = '[data-testid="runtime-task-close-cancel-button"]'
const searchInput = '[data-testid="workbench-search-input"]'
const searchCloseButton = '[data-testid="workbench-search-close-button"]'
const browserToggle = '[data-testid="browser-full-control-toggle"]:not(:disabled)'
const linkSelector = '[data-testid="browser-external-link-target"]'
const searchFixtureColor = [208, 24, 144]

function isSearchFixturePixel(pixel) {
  // Chromium's composited screenshot can round an 8-bit color channel by one.
  return pixel.every((channel, index) => Math.abs(channel - searchFixtureColor[index]) <= 1)
}

async function clickPoint(command, { x, y }) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

async function capturePixel(command, read, { x, y }) {
  const { data } = await command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x, y, width: 1, height: 1, scale: 1 },
  })
  return read(`(async () => {
    const png = Uint8Array.from(atob(${JSON.stringify(data)}), byte => byte.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')
    ctx.drawImage(bitmap, 0, 0, 1, 1)
    bitmap.close()
    return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
  })()`)
}

function assertIndicator(state, baseline, expectedLayers, description) {
  assert.equal(state.focused, true, `${description}: the control must own focus`)
  assert.equal(baseline.focused, false, `${description}: the baseline must be unfocused`)
  if (expectedLayers === 1)
    assert.equal(state.visible, true, `${description}: focus must be visible`)
  assert.equal(focusLayers(state.paint, baseline.paint), expectedLayers, description)
}

// Exercise the paint sampler on actual Chromium border longhands using the existing renderer.
async function verifyBorderFocusLayers(read) {
  const { baseline, outline, borderAndOutline } = await read(`(() => {
    const paint = (${readFocusPaint.toString()})
    const host = document.body.appendChild(document.createElement('div'))
    host.style.cssText = 'position: fixed; top: 8px; left: 8px'
    const previous = document.activeElement
    try {
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML = '<style>button { background: white; border: 1px solid gray; outline: none } button:focus { outline: 2px solid blue; outline-offset: 3px } button.accent:focus { border-color: blue }</style><button>Border sample</button>'
      const button = root.querySelector('button')
      const baseline = paint(button)
      button.focus({ preventScroll: true })
      if (!button.matches(':focus')) throw new Error('Chromium must focus the border sample')
      const outline = paint(button)
      button.classList.add('accent')
      return { baseline, outline, borderAndOutline: paint(button) }
    } finally {
      host.remove()
      previous?.focus({ preventScroll: true })
    }
  })()`)
  const grayBorder = focusLayers(outline, baseline)
  const blueBorder = focusLayers(borderAndOutline, baseline)
  assert.equal(grayBorder, 1, 'The resting gray border must be ignored')
  assert.equal(blueBorder, 2, 'The focused border and separated outline must both count')
  return { grayBorder, blueBorder }
}

function withChromeRenderer(inspect) {
  return withProjectRenderer(async (client, target) => {
    const command = (method, params) => client({ action: 'command', target, method, params })
    const read = async expression => {
      const response = await command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      assert.ok(
        !response.exceptionDetails,
        response.exceptionDetails?.exception?.description ?? response.exceptionDetails?.text
      )
      return response.result.value
    }
    return inspect({ command, read })
  })
}

async function verifySearchOverlay(
  { control, bridgeCall, address, resultDir, command, read },
  inspectDialog
) {
  // Keep pointer motion and clicks on the same native input path as the
  // compositor when moving between the host and its embedded guest.
  const linuxWindow = process.platform === 'linux' ? await activateLinuxMainWindow(control) : null
  const onWindows = process.platform === 'win32'
  if (onWindows) await control.command('focusMainWindow', 'body')
  const movePointer = point => {
    if (linuxWindow) return moveLinuxWindowPointer(linuxWindow, point)
    if (onWindows) return moveWindowsWindowPointer(control, point)
    return command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  }
  const pressAndRelease = point => {
    if (linuxWindow) return clickLinuxPointer()
    if (onWindows) return moveWindowsWindowPointer(control, point, true)
    return clickPoint(command, point)
  }
  const click = async point => {
    if (linuxWindow) return moveLinuxWindowPointer(linuxWindow, point, 1)
    if (onWindows) return moveWindowsWindowPointer(control, point, true)
    await movePointer(point)
    await pressAndRelease(point)
  }
  const pagePath = join(resultDir, 'search-overlay-page.html')
  await writeFile(
    pagePath,
    `<!doctype html><title>Search overlay fixture</title>
      <style>button { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: rgb(${searchFixtureColor.join(',')}); }</style>
      <button id="page" aria-label="Test page" data-clicks="0" data-downs="0" data-ups="0" data-moves="0"
        onpointermove="this.dataset.moves=Number(this.dataset.moves)+1"
        onpointerdown="this.dataset.downs=Number(this.dataset.downs)+1"
        onpointerup="this.dataset.ups=Number(this.dataset.ups)+1"
        onclick="this.dataset.clicks=Number(this.dataset.clicks)+1"></button>`
  )
  assert.equal((await bridgeCall({ action: 'open', url: pathToFileURL(pagePath).href })).ok, true)
  assert.equal(
    (
      await bridgeCall({
        action: 'waitFor',
        options: { condition: { selectorVisible: '#page' } },
        timeoutMs: 5000,
      })
    ).ok,
    true
  )
  const pageBounds = await read(`document.querySelector(${JSON.stringify(address)})
      .closest('[data-active-workbench-pane]').querySelector('[data-testid="workspace-browser-electron-webview-placeholder"]').getBoundingClientRect().toJSON()`)
  // Wait for the fixture's opaque paint; a transitional frame may already look magenta.
  const pagePixel = await waitForValue(
    () =>
      capturePixel(command, read, {
        x: Math.floor(pageBounds.x + pageBounds.width / 2),
        y: Math.floor(pageBounds.y + pageBounds.height / 2),
      }),
    isSearchFixturePixel,
    'The magenta fixture must be painted before opening search',
    5_000
  )
  const trigger = await read(`(() => {
      const button = document.querySelector('[data-testid="runtime-search-button"]')
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
  // Chromium can still route pointer input to a guest after the host trigger is visible.
  // Observe trusted motion on the search trigger before sending the only click.
  try {
    await read(`(() => {
      const abort = new AbortController()
      const observation = { abort, event: null, clicks: {} }
      window.__weworkSearchTriggerMotion = observation
      document.addEventListener('pointermove', event => {
        observation.event = {
          sequence: (observation.event?.sequence ?? 0) + 1,
          x: event.clientX, y: event.clientY, trusted: event.isTrusted,
          onTrigger: event.target instanceof Element && Boolean(event.target.closest('[data-testid="runtime-search-button"]'))
        }
      }, { capture: true, signal: abort.signal })
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        document.addEventListener(type, event => {
          const target = event.target instanceof Element ? event.target : null
          observation.clicks[type] = {
            x: event.clientX, y: event.clientY, trusted: event.isTrusted,
            target: target?.closest('[data-testid]')?.getAttribute('data-testid') ?? target?.localName
          }
        }, { capture: true, signal: abort.signal })
      }
      return true
    })()`)
    let offset = 1
    let point = null
    let after = 0
    const reachedTrigger = ({ point, after, event }) =>
      point &&
      event?.sequence > after &&
      event.trusted &&
      event.onTrigger &&
      event.x === point.x &&
      event.y === point.y
    const ready = await waitForValue(
      async () => {
        // The previous move may complete after the first read; check it before probing again.
        const event = await read('window.__weworkSearchTriggerMotion.event')
        if (reachedTrigger({ point, after, event })) return { point, after, event }
        after = event?.sequence ?? 0
        point = { x: Math.round(trigger.x) + offset, y: Math.round(trigger.y) }
        offset = -offset
        await movePointer(point)
        return { point, after, event: await read('window.__weworkSearchTriggerMotion.event') }
      },
      reachedTrigger,
      'Native pointer movement must reach the search trigger',
      5_000
    )
    console.info('[embedded-browser] search trigger pointer ready', JSON.stringify(ready))
    await pressAndRelease(ready.point)
    await waitForValue(
      () =>
        read(`(() => {
          const input = document.querySelector(${JSON.stringify(searchInput)})
          const active = document.activeElement
          return { open: Boolean(input), focused: Boolean(input && input === active),
            active: active?.dataset.testid || active?.localName,
            pointer: window.__weworkSearchTriggerMotion.clicks }
        })()`),
      state => state.focused,
      'Opening search must focus its input',
      5_000
    )
  } finally {
    await read(`(() => {
      window.__weworkSearchTriggerMotion?.abort.abort()
      delete window.__weworkSearchTriggerMotion
      return true
    })()`)
  }
  const focus = await inspectDialog?.()
  const overlap = await read(`(() => {
      const close = document.querySelector(${JSON.stringify(searchCloseButton)}).getBoundingClientRect()
      const dialog = document.querySelector('[data-testid="workbench-search-dialog"]')
      const bounds = dialog.getBoundingClientRect()
      return { close: { x: Math.floor(close.x + close.width / 2), y: Math.floor(close.y + close.height / 2) },
        sample: { x: Math.floor(close.x + close.width / 2), y: Math.floor(bounds.bottom - 20) },
        bounds: bounds.toJSON(), surface: getComputedStyle(dialog).backgroundColor }
    })()`)
  for (const { x, y } of [overlap.close, overlap.sample]) {
    assert.ok(
      x >= pageBounds.left && x < pageBounds.right && y >= pageBounds.top && y < pageBounds.bottom,
      `Search test must overlap the webview: ${JSON.stringify({ overlap, pageBounds })}`
    )
  }
  const dialogPixel = await capturePixel(command, read, overlap.sample)
  await writeFile(
    join(resultDir, 'search-overlay-paint.json'),
    JSON.stringify({ overlap, pageBounds, pagePixel, dialogPixel }, null, 2)
  )
  assert.deepEqual(
    dialogPixel,
    colorChannels(overlap.surface).slice(0, 3),
    'The composed window must show the search dialog over the guest page'
  )
  const readHit = `(() => {
    const label = document.querySelector(${JSON.stringify(address)})
      .closest('[data-embedded-browser-label]').dataset.embeddedBrowserLabel
    const view = [...document.querySelectorAll('[data-wework-browser-webview]')]
      .find(element => element.dataset.weworkBrowserWebview === label)
    const hit = document.elementFromPoint(${overlap.close.x}, ${overlap.close.y})
    return { guest: Boolean(view && hit && view.contains(hit)),
      closeButton: Boolean(hit?.closest(${JSON.stringify(searchCloseButton)})),
      pointerEvents: view && getComputedStyle(view).pointerEvents,
      inert: Boolean(view?.closest('[inert]')),
      dialog: Boolean(document.querySelector('[data-testid="workbench-search-dialog"]')),
      hit: hit && (hit.dataset.testid || hit.localName), active: document.activeElement?.dataset.testid }
  })()`
  const openHit = await read(readHit)
  assert.ok(openHit.closeButton && !openHit.guest, 'The search close button must receive the click')
  await click(overlap.close)
  await control.command('waitFor', searchInput, { visible: false, timeoutMs: 5_000 })
  const restoredPixel = await waitForValue(
    () => capturePixel(command, read, overlap.sample),
    isSearchFixturePixel,
    'The guest page must be visible again after closing search',
    5000
  )
  const readGuestInput = async () => {
    const result = await bridgeCall({
      action: 'evaluate',
      expression: `(() => {
        const { clicks, downs, ups, moves } = document.querySelector('#page').dataset
        return { clicks: Number(clicks), downs: Number(downs), ups: Number(ups), moves: Number(moves) }
      })()`,
    })
    assert.equal(result.ok, true, 'The guest input counters must be readable')
    return result.value
  }
  const { moves: closedMoves, ...closedInput } = await readGuestInput()
  assert.deepEqual(
    closedInput,
    { clicks: 0, downs: 0, ups: 0 },
    'The dialog dismissal must stay out of the guest page'
  )
  // The overlay observer reconciles native pointer ownership after the dialog unmounts.
  // A restored pixel does not guarantee that the guest can receive input yet.
  const readyHit = await waitForValue(
    () => read(readHit),
    state => state.guest && !state.inert && !state.dialog,
    'The restored guest must own the former close-button hit target',
    5_000
  )
  // Move from the former close button into the restored surface, then back
  // to verify native input at the exact point where the dialog intercepted it.
  const moveInGuest = async (point, previousMoves) => {
    // Chromium can route the first motion after the DOM hit target recovers to the
    // host, and it reports no motion when the pointer does not move. Nudge across
    // the restored boundary until the guest observes motion, then settle on the
    // exact point so the native click lands where the dialog intercepted it.
    let offset = 1
    const primed = await waitForValue(
      async () => {
        await movePointer({ x: point.x + offset, y: point.y })
        offset = 3 - offset
        return readGuestInput()
      },
      state => state.moves > previousMoves,
      `Native pointer movement near ${point.x},${point.y} must reach the restored guest`,
      5_000
    )
    await movePointer(point)
    return waitForValue(
      readGuestInput,
      state => state.moves > primed.moves,
      `Native pointer movement at ${point.x},${point.y} must reach the restored guest`,
      5_000
    )
  }
  const beforeMove = await readGuestInput()
  const approached = await moveInGuest(overlap.sample, beforeMove.moves)
  const clickTarget = overlap.close
  const { moves: readyMoves, ...readyInput } = await moveInGuest(clickTarget, approached.moves)
  assert.deepEqual(readyInput, closedInput, 'Moving into the guest must not click it')
  await pressAndRelease(clickTarget)
  const pageClicked = await bridgeCall({
    action: 'waitFor',
    options: {
      condition: { expression: 'document.querySelector("#page")?.dataset.clicks === "1"' },
    },
    timeoutMs: 5000,
  })
  const { moves: finalMoves, ...guestInput } = await readGuestInput()
  await writeFile(
    join(resultDir, 'search-overlay-input.json'),
    JSON.stringify(
      {
        restoredPixel,
        openHit,
        readyHit,
        closedInput,
        pointerMoves: {
          closed: closedMoves,
          before: beforeMove.moves,
          ready: readyMoves,
          final: finalMoves,
        },
        guestInput,
        finalHit: await read(readHit),
      },
      null,
      2
    )
  )
  assert.equal(
    pageClicked.ok,
    true,
    'The restored guest page must receive exactly one native click'
  )
  assert.deepEqual(guestInput, { clicks: 1, downs: 1, ups: 1 })
  await writeFile(
    join(resultDir, 'search-overlay-paint.json'),
    JSON.stringify(
      {
        overlap,
        pageBounds,
        pagePixel,
        dialogPixel,
        restoredPixel,
        closedClicks: closedInput.clicks,
        restoredClicks: guestInput.clicks,
      },
      null,
      2
    )
  )
  return focus
}

export async function verifyBrowserChromeFocus({
  control,
  bridgeCall,
  fixtureUrl,
  address,
  resultDir,
  searchOverlayOnly = false,
}) {
  if (searchOverlayOnly) {
    return withChromeRenderer(async ({ command, read }) => {
      await control.command('focusMainWindow', 'body')
      return verifySearchOverlay(
        { control, bridgeCall, address, resultDir, command, read },
        async () => {
          await control.command('nativePress', searchInput, { key: 'Tab' })
          await control.command('nativePress', searchCloseButton, { key: 'Shift+Tab' })
        }
      )
    })
  }
  const historyUrl = fixtureUrl + '?weg-address-history'
  assert.equal((await bridgeCall({ action: 'open', url: historyUrl, timeoutMs: 5_000 })).ok, true)
  assert.equal(
    (
      await bridgeCall({
        action: 'waitFor',
        options: {
          condition: {
            expression: `location.href === ${JSON.stringify(historyUrl)} && document.readyState === 'complete'`,
          },
        },
        timeoutMs: 5_000,
      })
    ).ok,
    true,
    'The local history fixture must finish navigating'
  )
  assert.equal((await bridgeCall({ action: 'open', url: fixtureUrl, timeoutMs: 5_000 })).ok, true)
  await control.command('waitFor', address, { visible: true, timeoutMs: 5_000 })
  const evidence = await withChromeRenderer(async ({ command, read }) => {
    await control.command('focusMainWindow', 'body')
    const borderSample = await verifyBorderFocusLayers(read)
    const sample = (selector, includeAddress = false) =>
      read(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)})
      await Promise.allSettled(el.getAnimations().map(animation => animation.finished))
      const paint = (${readFocusPaint.toString()})
      return { tag: el.localName, id: el.dataset.testid, role: el.getAttribute('role'),
        modality: document.documentElement.dataset.inputModality ?? null,
        focused: el === document.activeElement, visible: el.matches(':focus-visible'),
        paint: paint(el), ...(${includeAddress} ? {
          form: paint(el.form), value: el.value,
          muted: getComputedStyle(el).getPropertyValue('--color-muted').trim(),
          highlighted: document.querySelector('[data-testid="workspace-browser-address-suggestions"] [data-highlighted]')?.dataset.testid
        } : {}) }
    })()`)
    const sampleAddress = () => sample(address, true)
    const waitForFocus = selector =>
      waitForValue(
        () =>
          read(`document.querySelector(${JSON.stringify(selector)}) === document.activeElement`),
        focused => focused,
        `Expected focus on ${selector}`,
        5_000
      )
    const point = await read(`(() => {
      const el = document.querySelector(${JSON.stringify(address)}), rect = el.getBoundingClientRect()
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
      return { x, y, hit: document.elementFromPoint(x, y) === el }
    })()`)
    assert.ok(point.hit, 'The address bar must receive native pointer input')
    await clickPoint(command, point)
    const pointer = await sampleAddress()
    await command('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      commands: ['selectAll'],
    })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
    assert.ok(
      await read(
        `document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length`
      ),
      'Select All must select the full address before typing'
    )
    for (const key of 'weg') {
      const params = {
        key,
        code: 'Key' + key.toUpperCase(),
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      }
      await command('Input.dispatchKeyEvent', { type: 'keyDown', ...params, text: key })
      await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    }
    const defaultOption = '[data-testid="workspace-browser-address-submit"][data-highlighted]'
    const option = `[data-testid="workspace-browser-address-history-option"][data-url="${historyUrl}"]`
    await control.command('waitFor', option, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    await control.command('waitFor', defaultOption, {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const typed = await sampleAddress()
    await control.command('nativePress', address, { key: 'ArrowDown' })
    await control.command('waitFor', option + '[data-highlighted]', {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const selected = await sampleAddress()
    await control.command('nativePress', address, { key: 'ArrowUp' })
    await control.command('waitFor', defaultOption, {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const returned = await sampleAddress()
    await control.command('nativePress', address, { key: 'Escape' })
    await control.command('nativePress', address, { key: 'Tab' })
    const addressBaseline = await sampleAddress()
    const downloads =
      '[data-active-workbench-pane="true"] [data-testid="workspace-browser-downloads-button"]'
    await waitForFocus(downloads)
    await control.command('nativePress', downloads, { key: 'Shift+Tab' })
    const keyboard = await sampleAddress()
    let highContrast
    let highContrastBaseline
    try {
      await command('Emulation.setEmulatedMedia', {
        features: [{ name: 'forced-colors', value: 'active' }],
      })
      assert.ok(await read("matchMedia('(forced-colors: active)').matches"))
      await control.command('nativePress', address, { key: 'Tab' })
      await waitForFocus(downloads)
      highContrastBaseline = await sampleAddress()
      await control.command('nativePress', downloads, { key: 'Shift+Tab' })
      await waitForFocus(address)
      highContrast = await sampleAddress()
    } finally {
      await command('Emulation.setEmulatedMedia', { features: [] })
    }

    const { searchCloseBaseline, searchClose, searchBaseline, search } = await verifySearchOverlay(
      { control, bridgeCall, address, resultDir, command, read },
      async () => {
        const searchCloseBaseline = await sample(searchCloseButton)
        await control.command('nativePress', searchInput, { key: 'Tab' })
        const searchClose = await sample(searchCloseButton)
        const searchBaseline = await sample(searchInput)
        await control.command('nativePress', searchCloseButton, { key: 'Shift+Tab' })
        const search = await sample(searchInput)
        return { searchCloseBaseline, searchClose, searchBaseline, search }
      }
    )

    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('click', '[data-testid="settings-nav-browser"]')
    await control.command('waitFor', browserToggle, { timeoutMs: 5_000 })
    await control.command('nativePress', browserToggle, { key: 'Tab' })
    const linkTarget = await sample(linkSelector)
    const fullControlBaseline = await sample(browserToggle)
    await control.command('nativePress', linkSelector, { key: 'Shift+Tab' })
    const fullControl = await sample(browserToggle)
    const linkBaseline = await sample(linkSelector)
    await control.command('click', '[data-testid="settings-back-button"]')

    await control.command('requestMainWindowClose', 'body')
    await control.command('waitFor', dialog, { visible: true, timeoutMs: 5_000 })
    let focusError
    let focusEvidence
    try {
      await waitForFocus(dialog)
      const opened = await sample(dialog)
      const quitBaseline = await sample(quitButton)
      await control.command('nativePress', dialog, { key: 'Tab' })
      const tabbed = await sample(quitButton)
      const dialogBaseline = await sample(dialog)
      focusEvidence = {
        borderSample,
        pointer,
        typed,
        selected,
        returned,
        highContrast,
        highContrastBaseline,
        keyboard,
        search,
        searchClose,
        linkTarget,
        fullControl,
        opened,
        tabbed,
        baselines: {
          address: addressBaseline,
          search: searchBaseline,
          searchClose: searchCloseBaseline,
          link: linkBaseline,
          fullControl: fullControlBaseline,
          dialog: dialogBaseline,
          quit: quitBaseline,
        },
      }
    } catch (error) {
      focusError = error
    }
    try {
      await control.command('nativePress', dialog, { key: 'Escape' })
      await control.command('waitFor', dialog, { visible: false, timeoutMs: 5_000 })
    } catch (cleanupError) {
      if (focusError) {
        throw new AggregateError(
          [focusError, cleanupError],
          'Quit dialog focus and dismissal checks failed',
          {
            cause: focusError,
          }
        )
      }
      throw cleanupError
    }
    if (focusError) throw focusError
    return focusEvidence
  })
  await writeFile(join(resultDir, 'browser-chrome-focus.json'), JSON.stringify(evidence, null, 2))
  const baseline = evidence.baselines
  assert.equal(evidence.typed.value, 'weg')
  assert.equal(evidence.typed.highlighted, 'workspace-browser-address-submit')
  assert.equal(evidence.selected.highlighted, 'workspace-browser-address-history-option')
  assert.equal(evidence.returned.highlighted, 'workspace-browser-address-submit')
  for (const phase of ['pointer', 'typed', 'selected', 'returned', 'keyboard']) {
    const state = evidence[phase]
    assertIndicator(
      state,
      baseline.address,
      0,
      `${phase}: the address must have no additional focus ring`
    )
    assert.equal(
      focusLayers(state.form, baseline.address.form),
      0,
      `${phase}: the address form must have no additional focus ring`
    )
    assert.deepEqual(
      colorChannels(state.paint.backgrounds[0]),
      colorChannels(`rgb(${state.muted})`),
      `${phase}: the focused address must use the neutral theme surface`
    )
    assert.notDeepEqual(
      colorChannels(state.paint.backgrounds[0]),
      baseline.address.paint.backgrounds.map(colorChannels).find(channels => channels[3] === 1),
      `${phase}: focusing the address must visibly change its background`
    )
  }
  assert.ok(evidence.highContrast.focused && evidence.highContrast.visible)
  assert.ok(!['none', 'hidden'].includes(evidence.highContrast.paint.outlineStyle))
  assert.ok(parseFloat(evidence.highContrast.paint.outlineWidth) > 0)
  assert.ok(colorChannels(evidence.highContrast.paint.outlineColor)[3] > 0)
  assert.ok(!evidence.highContrastBaseline.focused)
  assert.ok(
    outlineContrast(evidence.highContrast.paint, evidence.highContrastBaseline.paint) >= 3,
    'The forced-colors focus outline must contrast with the adjacent surface by at least 3:1'
  )
  assertIndicator(evidence.search, baseline.search, 1, 'Tab must show one task search indicator')
  assertIndicator(
    evidence.searchClose,
    baseline.searchClose,
    1,
    'Tab must show one search close indicator'
  )
  assertIndicator(
    evidence.linkTarget,
    baseline.link,
    1,
    'Tab must show one link selector indicator'
  )
  assertIndicator(
    evidence.fullControl,
    baseline.fullControl,
    1,
    'Tab must show one browser switch indicator'
  )
  assertIndicator(
    evidence.opened,
    baseline.dialog,
    0,
    'Opening the close dialog must focus its content without a ring'
  )
  assertIndicator(evidence.tabbed, baseline.quit, 1, 'Tab must show one quit button indicator')
}
