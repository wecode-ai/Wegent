import type { BrowserWindow, WebContents } from 'electron'
import type { WorkbenchService } from './workbench-application-contract.js'
import { pendingWorkbenchInstallationWindow } from './workbench-installation.js'
import { evaluateWorkbenchPage } from './e2e-workbench-page.js'
import { LIGHTWEIGHT_WORKBENCH_FRAME_NAME } from './lightweight-workbench-client.js'

const STEP_TIMEOUT_MS = 10_000

interface WorkbenchControlHost extends WorkbenchService {
  windowForId(id: string): BrowserWindow | null
  contentsForId(id: string): WebContents | null
  isViewVisible(id: string): boolean
}

export async function controlWorkbenchApp(
  host: WorkbenchControlHost | null,
  params: Record<string, unknown>,
  routeScheme: (url: string) => boolean
): Promise<unknown> {
  if (process.env.VITE_WEWORK_E2E !== 'true' || !process.env.WEWORK_E2E_CONTROL_URL)
    throw new Error('Workbench E2E control is disabled')
  if (!host) throw new Error('Workbench host is unavailable')
  if (params.action === 'installation') {
    const prompt = pendingWorkbenchInstallationWindow()
    if (!prompt || prompt.isDestroyed()) return { visible: false, ready: false }
    if (params.choice !== undefined) {
      if (!['accept', 'cancel'].includes(String(params.choice)))
        throw new Error('Invalid installation choice')
      const testId =
        params.choice === 'accept' ? 'workbench-install-accept' : 'workbench-install-cancel'
      await clickInstallationButton(prompt, testId)
      return { clicked: true }
    }
    return {
      visible: prompt.isVisible(),
      ready: await prompt.webContents.executeJavaScript(
        'Boolean(document.querySelector(\'[data-testid="workbench-install-accept"]\'))'
      ),
    }
  }
  if (params.action === 'scheme') {
    if (typeof params.url !== 'string' || !routeScheme(params.url))
      throw new Error('Expected a Workbench scheme URL')
    return { queued: true }
  }
  if (typeof params.id !== 'string') throw new Error('Workbench installation id is required')
  const window = host.windowForId(params.id)
  const contents = host.contentsForId(params.id)
  const installation = (await host.list()).find(item => item.id === params.id)
  const available = contents && !contents.isDestroyed()
  if (params.action === 'snapshot') {
    return {
      running: installation?.state === 'running',
      visible: host.isViewVisible(params.id),
      url: available ? contents.getURL() : null,
      contentsId: available ? contents.id : null,
      presentation: installation?.presentation ?? null,
      sdkAvailable: available
        ? Boolean(await evaluateWorkbenchPage(contents, 'Boolean(window.weworkWorkbench)'))
        : false,
    }
  }
  if (!available) throw new Error('Workbench window is not running')
  if (params.action === 'close') {
    if (!window || window.isDestroyed())
      throw new Error('Workbench is not in an independent window')
    window.close()
    return { closed: true }
  }
  if (params.action === 'document') {
    return evaluateWorkbenchPage(
      contents,
      'Promise.resolve().then(async () => ({ sdk: Boolean(window.weworkWorkbench), text: document.body.textContent, state: await window.weworkWorkbench?.storage.get() }))'
    )
  }
  if (params.action === 'capture') return (await contents.capturePage()).toDataURL()
  if (params.action === 'setWindowValue' || params.action === 'getWindowValue') {
    if (typeof params.key !== 'string' || !/^__wework[A-Za-z0-9_]{1,100}$/.test(params.key))
      throw new Error('Expected an E2E workbench state key')
    const key = JSON.stringify(params.key)
    return evaluateWorkbenchPage(
      contents,
      params.action === 'setWindowValue'
        ? `(window[${key}] = ${JSON.stringify(params.value)})`
        : `window[${key}]`
    )
  }
  if (typeof params.selector !== 'string' || params.selector.length > 1000)
    throw new Error('Workbench selector is required')
  const selector = JSON.stringify(params.selector)
  switch (params.action) {
    case 'getText':
      return evaluateWorkbenchPage(
        contents,
        `document.querySelector(${selector})?.textContent ?? null`
      )
    case 'getValue':
      return evaluateWorkbenchPage(contents, `document.querySelector(${selector})?.value ?? null`)
    case 'click':
      return clickWorkbenchElement(contents, selector)
    case 'clickAndWaitForBlockedNavigation':
      if (typeof params.url !== 'string') throw new Error('Expected navigation URL is required')
      return clickAndWaitForBlockedNavigation(contents, selector, params.url)
    case 'fill': {
      if (typeof params.value !== 'string') throw new Error('Workbench input value must be text')
      return evaluateWorkbenchPage(
        contents,
        `(() => {
        const target = document.querySelector(${selector})
        if (!(target instanceof window.HTMLInputElement) || target.disabled) throw new Error('Workbench input is unavailable')
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(target, ${JSON.stringify(params.value)})
        target.dispatchEvent(new window.Event('input', { bubbles: true }))
        target.dispatchEvent(new window.Event('change', { bubbles: true }))
        return true
      })()`
      )
    }
    default:
      throw new Error('Unknown Workbench control action')
  }
}

async function clickInstallationButton(window: BrowserWindow, testId: string): Promise<void> {
  const position = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-testid="${testId}"]')
    if (!button || button.disabled || !button.checkVisibility()) return null
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const bounds = button.getBoundingClientRect()
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  })()`)
  if (!position) throw new Error('Installation confirmation is not ready')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      window.removeListener('closed', closed)
    }
    const failed = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const closed = () => {
      cleanup()
      resolve()
    }
    const timeout = setTimeout(
      () => failed(new Error('Installation confirmation did not close after the native click')),
      STEP_TIMEOUT_MS
    )
    window.on('closed', closed)
    try {
      if (window.isDestroyed()) throw new Error('Installation confirmation is no longer available')
      window.focus()
      window.webContents.sendInputEvent({ type: 'mouseMove', ...position })
      window.webContents.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        ...position,
      })
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...position,
      })
    } catch (error) {
      failed(error)
    }
  })
}

function clickWorkbenchElement(contents: WebContents, selector: string): Promise<unknown> {
  return evaluateWorkbenchPage(
    contents,
    `(() => {
      const target = document.querySelector(${selector})
      if (!target || target.disabled) throw new Error('Workbench control is unavailable')
      target.click()
      return true
    })()`
  )
}

async function clickAndWaitForBlockedNavigation(
  contents: WebContents,
  selector: string,
  url: string
): Promise<unknown> {
  const frame = contents.mainFrame.frames.find(
    candidate => candidate.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME
  )
  if (!frame) throw new Error('Lightweight Workbench frame is unavailable')
  let cleanup = () => {}
  const blocked = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Workbench navigation was not observed: ${url}`)),
      STEP_TIMEOUT_MS
    )
    const observe = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      if (event.frame !== frame || event.url !== url) return
      if (!event.defaultPrevented) reject(new Error(`Workbench navigation was not blocked: ${url}`))
      else resolve()
    }
    contents.on('will-frame-navigate', observe)
    contents.on('will-redirect', observe)
    cleanup = () => {
      clearTimeout(timeout)
      contents.removeListener('will-frame-navigate', observe)
      contents.removeListener('will-redirect', observe)
    }
  })
  try {
    await Promise.all([blocked, clickWorkbenchElement(contents, selector)])
    return { clicked: true, blocked: true, url }
  } finally {
    cleanup()
  }
}
