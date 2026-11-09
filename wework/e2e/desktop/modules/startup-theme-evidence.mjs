import assert from 'node:assert/strict'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const APPEARANCE_KEY = 'wework.appearance'
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
// The original Wework defaults are owned by the named theme catalogue.
// Core DSH owns body styles; inspect the Wework tokens and their actual consumers.
const WEWORK_PALETTE = {
  light: { background: '255 255 255', text: '26 26 26' },
  dark: { background: '24 24 24', text: '255 255 255' },
}
const ACTIVE_WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const BACKGROUND_SELECTOR = `${ACTIVE_WORKBENCH} main`
const TEXT_SELECTOR = `${ACTIVE_WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`

function rgb(triplet) {
  return `rgb(${triplet.split(' ').join(', ')})`
}

function record(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

/** Seed only the stopped checkpoint application, before launch or inside afterStop. */
export async function seedStoppedStartupTheme({ resultDir, userDataDirectory, mode }) {
  assert.ok(mode === 'light' || mode === 'dark', 'The startup evidence needs an explicit theme')
  assert.equal(
    resolve(userDataDirectory),
    resolve(resultDir, 'electron-user-data'),
    'Startup theme fixtures must use the isolated checkpoint user data'
  )
  const preferencesPath = join(userDataDirectory, 'app-preferences.json')
  const storagePath = join(userDataDirectory, 'renderer-local-storage.json')
  const preferences = record(JSON.parse(await readFile(preferencesPath, 'utf8')))
  const storage = record(JSON.parse(await readFile(storagePath, 'utf8')))
  assert.equal(storage.version, 1)
  const entries = record(storage.entries)
  const appearance = entries[APPEARANCE_KEY] ? record(JSON.parse(entries[APPEARANCE_KEY])) : {}
  await writeFile(
    preferencesPath,
    `${JSON.stringify({ ...preferences, appearanceMode: mode }, null, 2)}\n`,
    { mode: 0o600 }
  )
  await writeFile(
    storagePath,
    `${JSON.stringify(
      {
        ...storage,
        entries: { ...entries, [APPEARANCE_KEY]: JSON.stringify({ ...appearance, mode }) },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  return { mode, seededAt: Date.now() }
}

async function documentTimeOrigin(control) {
  const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  assert.ok(Number.isFinite(debug.timeOrigin), 'The main document has no generation timestamp')
  return debug.timeOrigin
}

export async function captureStartupThemeEvidence({
  control,
  snapshot,
  seed,
  resultDir,
  splashCapturePath = join(resultDir, 'startup-splash.png'),
}) {
  assert.ok(Number.isFinite(seed?.seededAt), 'The theme fixture was not seeded before launch')
  const mode = seed.mode
  assert.ok(mode === 'light' || mode === 'dark')
  assert.equal(snapshot.theme, mode, 'The native startup resolved a different target theme')
  assert.equal(snapshot.state, 'closed')
  assert.equal(snapshot.handoff?.completion?.progressNow, 100)
  const stageAppearance = snapshot.handoff.completion.appearance
  assert.equal(stageAppearance.theme, mode, 'The splash rendered a different theme')
  assert.equal(stageAppearance.colorScheme, mode)
  assert.equal(stageAppearance.background, mode === 'dark' ? 'rgb(5, 7, 13)' : 'rgb(250, 250, 250)')
  assert.equal(stageAppearance.footerBackground, stageAppearance.background)
  const createdAt = snapshot.events.find(event => event.name === 'created')?.timestamp
  const closedAt = snapshot.events.find(event => event.name === 'closed')?.timestamp
  assert.ok(createdAt >= seed.seededAt, 'The splash evidence belongs to an earlier launch')
  const timeOrigin = await documentTimeOrigin(control)
  assert.ok(
    timeOrigin >= createdAt && timeOrigin <= closedAt,
    'The main document does not belong to the completed native startup'
  )
  const rendered = {
    owner: 'wework',
    theme: await control.command('getAttribute', 'html', { value: 'data-theme' }),
    appearanceMode: await control.command('getAttribute', 'html', {
      value: 'data-appearance-mode',
    }),
    colorScheme: await control.command('getComputedStyleValue', 'html', { value: 'color-scheme' }),
    selectors: { palette: 'html', background: BACKGROUND_SELECTOR, text: TEXT_SELECTOR },
    palette: {
      background: await control.command('getComputedStyleValue', 'html', {
        value: '--color-bg-base',
      }),
      text: await control.command('getComputedStyleValue', 'html', {
        value: '--color-text-primary',
      }),
    },
    background: await control.command('getComputedStyleValue', BACKGROUND_SELECTOR, {
      value: 'background-color',
    }),
    text: await control.command('getComputedStyleValue', TEXT_SELECTOR, { value: 'color' }),
    hostDocument: {
      owner: 'core-dsh',
      background: await control.command('getComputedStyleValue', 'body', {
        value: 'background-color',
      }),
      text: await control.command('getComputedStyleValue', 'body', { value: 'color' }),
    },
  }
  assert.equal(rendered.theme, mode)
  assert.equal(rendered.appearanceMode, mode)
  assert.equal(rendered.colorScheme, mode)
  assert.equal(rendered.palette.background, WEWORK_PALETTE[mode].background)
  assert.equal(rendered.palette.text, WEWORK_PALETTE[mode].text)
  assert.equal(rendered.background, rgb(WEWORK_PALETTE[mode].background))
  assert.equal(rendered.text, rgb(WEWORK_PALETTE[mode].text))
  const nativeWindow = JSON.parse(await control.command('getNativeWindowState', 'body'))
  assert.equal(nativeWindow.visible, true)
  assert.equal(nativeWindow.minimized, false)
  const splashPng = await readFile(splashCapturePath)
  assert.ok(splashPng.subarray(0, 8).equals(PNG_SIGNATURE))
  const splashName = `startup-theme-${mode}-splash.png`
  const mainName = `startup-theme-${mode}-main.png`
  if (resolve(splashCapturePath) !== resolve(resultDir, splashName))
    await copyFile(splashCapturePath, join(resultDir, splashName))
  // This is the real Electron capturePage path, independent of optional screenshot filters.
  const mainPng = await control.command('capture', 'body')
  const prefix = 'data:image/png;base64,'
  assert.ok(mainPng.startsWith(prefix))
  const image = Buffer.from(mainPng.slice(prefix.length), 'base64')
  assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE))
  await writeFile(join(resultDir, mainName), image)
  assert.equal(
    await documentTimeOrigin(control),
    timeOrigin,
    'The main document changed while capturing startup theme evidence'
  )
  const evidence = {
    targetTheme: mode,
    stageAppearance,
    source: 'native-electron-capturePage',
    generation: { seededAt: seed.seededAt, createdAt, documentTimeOrigin: timeOrigin, closedAt },
    rendered,
    nativeWindow,
    completion: snapshot.handoff.completion,
    captures: { splash: splashName, main: mainName },
  }
  await writeFile(
    join(resultDir, `startup-theme-${mode}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  return evidence
}
