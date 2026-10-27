'use strict'

const electron = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

if (!electron?.app) {
  console.error(
    'The startup splash preview must run under Electron. If ELECTRON_RUN_AS_NODE is set in this ' +
      'shell, remove it before running the preview.'
  )
  process.exit(1)
}

const { app, BrowserWindow, clipboard, ipcMain, shell } = electron

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1] ?? fallback
  const prefix = `--${name}=`
  const match = process.argv.find(argument => argument.startsWith(prefix))
  return match ? match.slice(prefix.length) : fallback
}

const requestedState = option('state', 'normal')
const state = requestedState === 'failed' ? 'failure' : requestedState
const stageId = option('stage', 'components')
const theme = option('theme', 'light') === 'dark' ? 'dark' : 'light'
const requestedElapsed = option('elapsed', null)
const activity = option('activity', null)
const plugin = option('plugin', '@wegent/ai-fleet-defense')
const capturePath = option('capture', null)
const requestedExitAfter = option('exit-after', null)
const exitAfter =
  requestedExitAfter === null || !Number.isFinite(Number(requestedExitAfter))
    ? null
    : Number(requestedExitAfter)

app.whenReady().then(async () => {
  const electronRoot = join(__dirname, '..')
  const dist = join(electronRoot, 'dist')
  let progressModule
  try {
    progressModule = await import(pathToFileURL(join(dist, 'host', 'startup-progress.js')).href)
  } catch (error) {
    console.error(
      'The startup splash preview needs a current build. Run: pnpm --dir wework/electron build',
      error
    )
    app.exit(1)
    return
  }

  const stages = progressModule.STARTUP_PROGRESS_STAGES
  const index = stages.findIndex(stage => stage.id === stageId)
  if (index < 0) {
    console.error(
      `Unknown stage "${stageId}". Available stages: ${stages.map(stage => stage.id).join(', ')}`
    )
    app.exit(1)
    return
  }
  const stage = stages[index]
  const parsedElapsed = requestedElapsed === null ? Number.NaN : Number(requestedElapsed)
  const elapsed = Number.isFinite(parsedElapsed)
    ? Math.max(0, parsedElapsed)
    : state === 'timeout'
      ? stage.timeoutMs + 1_000
      : state === 'slow'
        ? 31_000
        : 2_000
  const defaultActivity =
    stage.id === 'runtime-files'
      ? 'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/components/WorkbenchShell.js'
      : 'plugins/@wegent/ai-fleet-defense/dist/client/index.js'
  const activityPath = activity === 'none' ? null : activity || defaultActivity
  const update = {
    index,
    total: stages.length,
    completedWeight: stages
      .slice(0, index)
      .reduce((total, candidate) => total + candidate.weight, 0),
    stage,
    startedAt: Date.now() - elapsed,
    ...(activityPath
      ? {
          activity: {
            kind: stage.id === 'runtime-files' ? 'unpack' : 'scan',
            path: activityPath,
          },
        }
      : {}),
  }

  ipcMain.handle('startup-diagnostics:copy', () => {
    const text = [
      'Wework startup splash preview',
      `stage=${stage.id}`,
      `state=${state}`,
      `elapsedMs=${elapsed}`,
      `theme=${theme}`,
      `activity=${activityPath ?? 'none'}`,
    ].join('\n')
    clipboard.writeText(text)
    return { ok: true, characters: text.length }
  })
  ipcMain.handle('startup-diagnostics:open-logs', () => shell.openPath(app.getPath('logs')))
  for (const channel of [
    'startup-recovery:retry',
    'startup-recovery:recover-workbench',
    'startup-recovery:reset-app-state',
    'startup-recovery:disable-plugin',
  ]) {
    ipcMain.handle(channel, () => {
      app.quit()
      return { ok: true }
    })
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: `Wework startup splash preview — ${stage.id} / ${state}`,
    backgroundColor: theme === 'dark' ? '#181818' : '#fafafa',
    webPreferences: {
      preload: join(dist, 'startup-splash-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  await window.loadFile(join(dist, 'shell', 'startup-splash', 'index.html'), {
    query: { theme },
  })
  window.show()
  window.webContents.send('startup-progress:update', update)
  if (state === 'failure') {
    await new Promise(resolve => setTimeout(resolve, 250))
    await window.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('wework-startup-error', { detail: { pluginName: ${JSON.stringify(
        plugin
      )} } }))`
    )
  }
  console.log(
    `Startup splash preview: stage=${stage.id} state=${state} elapsed=${elapsed}ms theme=${theme}`
  )
  if (capturePath) {
    await new Promise(resolve => setTimeout(resolve, 400))
    await writeFile(capturePath, (await window.webContents.capturePage()).toPNG())
    console.log(`Wrote startup splash preview to ${capturePath}`)
    app.quit()
    return
  }
  if (exitAfter !== null) setTimeout(() => app.quit(), Math.max(0, exitAfter))
  window.on('closed', () => app.quit())
})

app.on('window-all-closed', () => app.quit())
