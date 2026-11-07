import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  captureStartupThemeEvidence,
  seedStoppedStartupTheme,
} from '../e2e/desktop/modules/startup-theme-evidence.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64'
)

async function directory(t) {
  const resultDir = await mkdtemp(join(tmpdir(), 'startup-theme-evidence-'))
  const userDataDirectory = join(resultDir, 'electron-user-data')
  await mkdir(userDataDirectory)
  await writeFile(
    join(userDataDirectory, 'app-preferences.json'),
    JSON.stringify({ telemetryConsentAsked: true })
  )
  await writeFile(
    join(userDataDirectory, 'renderer-local-storage.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'another-local-setting': 'retained',
        'wework.appearance': JSON.stringify({ mode: 'system', accentColor: '#339cff' }),
      },
    })
  )
  await writeFile(join(resultDir, 'startup-splash.png'), PNG)
  t.after(() => rm(resultDir, { recursive: true, force: true }))
  return { resultDir, userDataDirectory }
}

function captureFixture(mode, options = {}) {
  const calls = []
  let timeOriginReads = 0
  const snapshot = {
    state: 'closed',
    theme: mode,
    events: [
      { name: 'created', timestamp: 1100 },
      { name: 'closed', timestamp: 2000 },
    ],
    handoff: {
      completion: {
        progressNow: 100,
        fillEnd: 100,
        trackEnd: 100,
        appearance: {
          theme: options.splashTheme ?? mode,
          colorScheme: mode,
          background:
            options.splashBackground ?? (mode === 'dark' ? 'rgb(5, 7, 13)' : 'rgb(250, 250, 250)'),
          footerBackground:
            options.footerBackground ?? (mode === 'dark' ? 'rgb(5, 7, 13)' : 'rgb(250, 250, 250)'),
        },
      },
    },
  }
  const control = {
    async command(action, selector, params = {}) {
      calls.push(action)
      if (action === 'getWorkbenchDebugSnapshot')
        return JSON.stringify({ timeOrigin: options.timeOrigins?.[timeOriginReads++] ?? 1500 })
      if (action === 'getAttribute') return options.renderedMode ?? mode
      if (action === 'getComputedStyleValue') {
        if (selector === 'body') {
          return params.value === 'color' ? 'rgb(15, 17, 21)' : 'rgb(255, 255, 255)'
        }
        if (params.value === 'color-scheme') return mode
        if (params.value === '--color-bg-base') {
          assert.equal(selector, 'html')
          return options.backgroundToken ?? (mode === 'dark' ? '17 17 17' : '255 255 255')
        }
        if (params.value === '--color-text-primary') {
          assert.equal(selector, 'html')
          return options.textToken ?? (mode === 'dark' ? '252 252 252' : '13 13 13')
        }
        if (params.value === 'background-color') {
          assert.equal(
            selector,
            '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] main'
          )
          return options.background ?? (mode === 'dark' ? 'rgb(17, 17, 17)' : 'rgb(255, 255, 255)')
        }
        assert.equal(
          selector,
          '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]'
        )
        return options.text ?? (mode === 'dark' ? 'rgb(252, 252, 252)' : 'rgb(13, 13, 13)')
      }
      if (action === 'getNativeWindowState')
        return JSON.stringify({ visible: true, minimized: false })
      assert.equal(action, 'capture')
      assert.equal(selector, 'body')
      return `data:image/png;base64,${PNG.toString('base64')}`
    },
  }
  return { control, snapshot, seed: { mode, seededAt: 1000 }, calls }
}

for (const mode of ['light', 'dark']) {
  test(`seeds both stopped ${mode} preferences without replacing unrelated settings`, async t => {
    const paths = await directory(t)
    const seed = await seedStoppedStartupTheme({ ...paths, mode })
    assert.equal(seed.mode, mode)
    assert.ok(Number.isFinite(seed.seededAt))
    const preferences = JSON.parse(
      await readFile(join(paths.userDataDirectory, 'app-preferences.json'), 'utf8')
    )
    assert.deepEqual(preferences, { telemetryConsentAsked: true, appearanceMode: mode })
    const storage = JSON.parse(
      await readFile(join(paths.userDataDirectory, 'renderer-local-storage.json'), 'utf8')
    )
    assert.equal(storage.entries['another-local-setting'], 'retained')
    assert.deepEqual(JSON.parse(storage.entries['wework.appearance']), {
      mode,
      accentColor: '#339cff',
    })
  })

  test(`records matching ${mode} splash and main renderer appearances`, async t => {
    const { resultDir } = await directory(t)
    const fixture = captureFixture(mode)
    const evidence = await captureStartupThemeEvidence({ ...fixture, resultDir })
    assert.equal(evidence.targetTheme, mode)
    assert.deepEqual(evidence.stageAppearance, fixture.snapshot.handoff.completion.appearance)
    assert.equal(evidence.source, 'native-electron-capturePage')
    assert.equal(evidence.rendered.owner, 'wework')
    assert.deepEqual(evidence.rendered.palette, {
      background: mode === 'dark' ? '17 17 17' : '255 255 255',
      text: mode === 'dark' ? '252 252 252' : '13 13 13',
    })
    assert.deepEqual(evidence.rendered.hostDocument, {
      owner: 'core-dsh',
      background: 'rgb(255, 255, 255)',
      text: 'rgb(15, 17, 21)',
    })
    assert.equal(evidence.completion.progressNow, 100)
    assert.equal(fixture.calls.filter(action => action === 'capture').length, 1)
    assert.deepEqual(await readFile(join(resultDir, evidence.captures.main)), PNG)
    assert.deepEqual(await readFile(join(resultDir, evidence.captures.splash)), PNG)
    const saved = JSON.parse(await readFile(join(resultDir, `startup-theme-${mode}.json`), 'utf8'))
    assert.equal(saved.generation.documentTimeOrigin, 1500)
  })
}

for (const incorrect of [
  { splashTheme: 'dark' },
  { splashBackground: 'rgb(5, 7, 13)' },
  { footerBackground: 'rgb(255, 255, 255)' },
]) {
  test(`rejects a light startup with inconsistent splash ${Object.keys(incorrect)[0]}`, async t => {
    const { resultDir } = await directory(t)
    const fixture = captureFixture('light', incorrect)
    await assert.rejects(captureStartupThemeEvidence({ ...fixture, resultDir }))
    assert.deepEqual(fixture.calls, [])
  })
}

test('rejects a data directory outside the isolated checkpoint', async t => {
  const paths = await directory(t)
  await assert.rejects(
    seedStoppedStartupTheme({ ...paths, userDataDirectory: tmpdir(), mode: 'dark' }),
    /isolated checkpoint/
  )
})

test('rejects invalid persisted appearance before modifying either preference file', async t => {
  const paths = await directory(t)
  const preferencesPath = join(paths.userDataDirectory, 'app-preferences.json')
  const before = await readFile(preferencesPath, 'utf8')
  await writeFile(
    join(paths.userDataDirectory, 'renderer-local-storage.json'),
    JSON.stringify({ version: 1, entries: { 'wework.appearance': '{invalid' } })
  )
  await assert.rejects(seedStoppedStartupTheme({ ...paths, mode: 'dark' }))
  assert.equal(await readFile(preferencesPath, 'utf8'), before)
})

test('rejects a completed splash from an earlier launch', async t => {
  const { resultDir } = await directory(t)
  const fixture = captureFixture('light')
  fixture.snapshot.events[0].timestamp = 999
  await assert.rejects(captureStartupThemeEvidence({ ...fixture, resultDir }), /earlier launch/)
  assert.deepEqual(fixture.calls, [])
})

test('rejects a stale main document instead of accepting the target theme alone', async t => {
  const { resultDir } = await directory(t)
  const fixture = captureFixture('dark', { timeOrigins: [1099] })
  await assert.rejects(
    captureStartupThemeEvidence({ ...fixture, resultDir }),
    /does not belong to the completed native startup/
  )
  assert.ok(!fixture.calls.includes('capture'))
})

for (const incorrect of [
  { renderedMode: 'light' },
  { background: 'rgb(255, 255, 255)' },
  { text: 'rgb(15, 17, 21)' },
  { backgroundToken: '255 255 255' },
  { textToken: '26 26 26' },
]) {
  test(`rejects a dark target with inconsistent actual renderer ${Object.keys(incorrect)[0]}`, async t => {
    const { resultDir } = await directory(t)
    const fixture = captureFixture('dark', incorrect)
    await assert.rejects(captureStartupThemeEvidence({ ...fixture, resultDir }))
    assert.ok(!fixture.calls.includes('capture'))
  })
}

test('rejects a renderer generation change while the native frame is captured', async t => {
  const { resultDir } = await directory(t)
  const fixture = captureFixture('light', { timeOrigins: [1500, 1501] })
  await assert.rejects(
    captureStartupThemeEvidence({ ...fixture, resultDir }),
    /main document changed/
  )
  await assert.rejects(readFile(join(resultDir, 'startup-theme-light.json')), { code: 'ENOENT' })
})

test('requires the completed 100 percent frame before saving theme evidence', async t => {
  const { resultDir } = await directory(t)
  const fixture = captureFixture('light')
  fixture.snapshot.handoff.completion.progressNow = 99
  await assert.rejects(captureStartupThemeEvidence({ ...fixture, resultDir }))
  assert.ok(!fixture.calls.includes('capture'))
})
