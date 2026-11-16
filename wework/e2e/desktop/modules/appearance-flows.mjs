import { tmpdir } from 'node:os'

import {
  DEFAULT_STEP_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  rm,
  writeFile,
} from './shared.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const WORKBENCH_BACKGROUND_KEY = 'wework.appearance'
const WORKBENCH_BACKGROUND_FILENAME = 'wework-e2e-workbench-background.png'
const WORKBENCH_BACKGROUND_SELECTOR = '[data-testid="workbench-background"]'
const WORKBENCH_BACKGROUND_IMAGE_SELECTOR = '[data-testid="workbench-background-image"]'
const WORKBENCH_SIDEBAR_SELECTOR = '[data-testid="desktop-sidebar"]'
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const WORKBENCH_MAIN_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} main`
const WORKBENCH_PANE_GROUP_SELECTOR = '[data-testid^="workbench-pane-pane-"][data-focused="true"]'
const RIGHT_PANEL_SHELL_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
const RIGHT_PANEL_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel"]`
const SIDE_CHAT_PANEL_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-panel"]`
const SIDE_CHAT_COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-composer-shell"]`
const TEST_BACKGROUND_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAK0lEQVR4nO3OIQEAAAACIP+f1hkWAp007VMEBAQEBAQEBAQEBAQEBATegQH33vSm6TlGMAAAAABJRU5ErkJggg==',
  'base64'
)

function backgroundSettings(imagePath) {
  return JSON.stringify({
    backgroundImagePath: imagePath,
    backgroundVisibility: 100,
    backgroundBlur: 0,
    backgroundInMain: true,
    backgroundInSidebar: true,
    backgroundInTopBar: true,
  })
}

async function setAppearanceStorage(control, value) {
  await control.command('setLocalStorageItem', 'body', {
    value: JSON.stringify({ key: WORKBENCH_BACKGROUND_KEY, value }),
  })
}

function cssAlpha(value) {
  const color = value.trim()
  if (color === 'transparent') return 0

  const slashAlpha = color.match(/\/\s*([\d.]+)(%?)\s*\)/)
  if (slashAlpha) {
    return slashAlpha[2] === '%' ? Number(slashAlpha[1]) / 100 : Number(slashAlpha[1])
  }

  const channels = color
    .match(/^rgba?\((.*)\)$/)?.[1]
    .split(/[,\s]+/)
    .filter(Boolean)
  if (channels?.length === 4) {
    return Number(channels[3].replace('%', '')) / (channels[3].endsWith('%') ? 100 : 1)
  }
  return 1
}

async function elementMetrics(control, selector) {
  const metrics = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(metrics.length, 1, `${selector} rendered ${metrics.length} matching elements`)
  return metrics[0]
}

async function waitForElementWidth(control, selector, minimumWidth, description) {
  const startedAt = Date.now()
  let latest = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    latest = await elementMetrics(control, selector)
    if (latest.width >= minimumWidth) return latest
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${description} did not reach ${minimumWidth}px; last=${JSON.stringify(latest)}`)
}

function assertCovers(background, surface, description) {
  assert.ok(
    background.left <= surface.left + 0.5 &&
      background.right >= surface.right - 0.5 &&
      background.top <= surface.top + 0.5 &&
      background.bottom >= surface.bottom - 0.5,
    `${description} extends outside the workbench background: background=${JSON.stringify(
      background
    )} surface=${JSON.stringify(surface)}`
  )
}

async function assertClassAndAlpha(control, selector, expectedClass, description) {
  const classes = await control.command('getAttribute', selector, { value: 'class' })
  assert.ok(
    String(classes).split(/\s+/).includes(expectedClass),
    `${description} does not use ${expectedClass}: ${classes}`
  )
  const backgroundColor = await control.command('getComputedStyleValue', selector, {
    value: 'background-color',
  })
  const alpha = cssAlpha(backgroundColor)
  assert.ok(
    expectedClass === 'bg-transparent' ? alpha === 0 : alpha > 0 && alpha < 1,
    `${description} is not translucent (${backgroundColor})`
  )
}

async function waitForSurfaceOpen(control, selector, description) {
  const startedAt = Date.now()
  let latest = { ariaHidden: null, opacity: null }
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    latest = {
      ariaHidden: await control.command('getAttribute', selector, { value: 'aria-hidden' }),
      opacity: Number(
        await control.command('getComputedStyleValue', selector, { value: 'opacity' })
      ),
    }
    if (
      (latest.ariaHidden === null || latest.ariaHidden === '' || latest.ariaHidden === 'false') &&
      latest.opacity === 1
    ) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${description} did not finish opening: ${JSON.stringify(latest)}`)
}

async function ensureSideChatVisible(control) {
  if (
    Number(
      await control.command('getElementCount', RIGHT_PANEL_SHELL_SELECTOR, { visible: true })
    ) === 0
  ) {
    await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  }
  await control.command('waitFor', RIGHT_PANEL_SHELL_SELECTOR, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  if (
    Number(
      await control.command('getElementCount', SIDE_CHAT_PANEL_SELECTOR, { visible: true })
    ) === 0
  ) {
    const launcherOptionCount = Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-option"]`,
        {
          visible: true,
        }
      )
    )
    if (launcherOptionCount > 0) {
      await assertClassAndAlpha(
        control,
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-option"]`,
        'bg-surface/20',
        'The right workspace chat launcher item'
      )
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-option"]`
      )
    } else {
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-new-tab-button"]`
      )
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-option"]`
      )
    }
  }

  await control.command('waitFor', SIDE_CHAT_PANEL_SELECTOR, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

/**
 * The desktop renderer runs on an HTTP origin. The configured background must
 * therefore be read through the Electron file bridge and displayed as a Blob
 * URL, while the sidebar and side chat keep translucent surfaces over it.
 */
async function verifyWorkbenchBackgroundSurfaces({ control }) {
  const imagePath = join(tmpdir(), WORKBENCH_BACKGROUND_FILENAME)
  const originalAppearance = await control.command('getLocalStorageItem', 'body', {
    value: WORKBENCH_BACKGROUND_KEY,
  })
  await writeFile(imagePath, TEST_BACKGROUND_PNG)

  try {
    await setAppearanceStorage(control, backgroundSettings(imagePath))
    await reloadMainWindow(
      control,
      'The workbench background configuration did not survive an appearance reload'
    )
    await control.command('waitFor', WORKBENCH_BACKGROUND_SELECTOR, {
      visible: true,
      stableMs: 500,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `${WORKBENCH_BACKGROUND_IMAGE_SELECTOR}[data-image-loaded="true"]`,
      {
        stableMs: 300,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    assert.equal(
      await control.command('getAttribute', WORKBENCH_BACKGROUND_IMAGE_SELECTOR, {
        value: 'data-image-loaded',
      }),
      'true',
      'The workbench background image did not finish decoding'
    )

    const imageSrc = await control.command('getAttribute', WORKBENCH_BACKGROUND_IMAGE_SELECTOR, {
      value: 'src',
    })
    assert.ok(
      String(imageSrc).startsWith('blob:'),
      `The workbench background did not render through a Blob URL: ${imageSrc}`
    )

    const background = await elementMetrics(control, WORKBENCH_BACKGROUND_SELECTOR)
    await assertClassAndAlpha(
      control,
      '[data-testid="app-shell"]',
      'bg-transparent',
      'The desktop app shell'
    )
    const overlayOpacity = Number(
      await control.command(
        'getComputedStyleValue',
        '[data-testid="workbench-background-overlay"]',
        { value: 'opacity' }
      )
    )
    assert.equal(
      overlayOpacity,
      0,
      `The workbench background overlay covered the image at ${overlayOpacity} opacity`
    )
    assert.equal(
      await control.command('getComputedStyleValue', WORKBENCH_BACKGROUND_IMAGE_SELECTOR, {
        value: 'opacity',
      }),
      '1',
      'The workbench background image was rendered at reduced opacity'
    )
    const sidebar = await elementMetrics(control, WORKBENCH_SIDEBAR_SELECTOR)
    assert.ok(
      sidebar.width >= 200 && sidebar.height >= 300,
      `The sidebar is too small to verify the background: ${JSON.stringify(sidebar)}`
    )
    assertCovers(background, sidebar, 'The desktop sidebar')
    await assertClassAndAlpha(
      control,
      WORKBENCH_MAIN_SELECTOR,
      'bg-background/20',
      'The desktop workbench main surface'
    )
    await assertClassAndAlpha(
      control,
      WORKBENCH_PANE_GROUP_SELECTOR,
      'bg-transparent',
      'The workbench pane group'
    )
    await assertClassAndAlpha(
      control,
      WORKBENCH_SIDEBAR_SELECTOR,
      'bg-background/25',
      'The desktop sidebar'
    )
    await assertClassAndAlpha(
      control,
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="task-suggestion-category-explore"]`,
      'bg-transparent',
      'The home suggestion card'
    )

    await ensureSideChatVisible(control)
    const sideChat = await waitForElementWidth(
      control,
      SIDE_CHAT_PANEL_SELECTOR,
      200,
      'The side chat'
    )
    await waitForElementWidth(control, RIGHT_PANEL_SHELL_SELECTOR, 240, 'The right workspace shell')
    await control.command('finishAnimations', 'body')
    await waitForSurfaceOpen(control, RIGHT_PANEL_SHELL_SELECTOR, 'The right workspace shell')
    await waitForSurfaceOpen(control, SIDE_CHAT_PANEL_SELECTOR, 'The side chat')
    assertCovers(background, sideChat, 'The side chat')
    assert.ok(
      sideChat.height >= 300,
      `The side chat is too short to verify the background: ${JSON.stringify(sideChat)}`
    )
    await assertClassAndAlpha(
      control,
      RIGHT_PANEL_SHELL_SELECTOR,
      'bg-background/20',
      'The right workspace shell'
    )
    await assertClassAndAlpha(
      control,
      RIGHT_PANEL_SELECTOR,
      'bg-transparent',
      'The right workspace panel'
    )
    await assertClassAndAlpha(
      control,
      SIDE_CHAT_COMPOSER_SELECTOR,
      'bg-transparent',
      'The side chat composer'
    )
    await setAppearanceStorage(
      control,
      backgroundSettings(join(tmpdir(), 'wework-e2e-missing-background.png'))
    )
    await reloadMainWindow(control, 'The missing workbench background fixture did not reload')
    await control.command('waitFor', '[data-testid="new-chat-button"]', {
      visible: true,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', WORKBENCH_BACKGROUND_SELECTOR, {
      visible: false,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  } finally {
    if (originalAppearance) {
      await setAppearanceStorage(control, originalAppearance)
    } else {
      await control.command('removeLocalStorageItem', 'body', { value: WORKBENCH_BACKGROUND_KEY })
    }
    await reloadMainWindow(control, 'The workbench appearance fixture did not restore')
    await rm(imagePath, { force: true })
  }

  await control.command('waitFor', '[data-testid="new-chat-button"]', {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

export { verifyWorkbenchBackgroundSurfaces }
