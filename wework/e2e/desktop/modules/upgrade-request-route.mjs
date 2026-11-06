import { inspectBeforeStart, inspectRunningApp } from './inspect-before-start.mjs'
import { appendFileSync } from 'node:fs'

const publishedBase = 'https://github.com/wecode-ai/Wegent/releases/download/wework-updater/'

export async function routeUpgradeRequests(
  child,
  origin,
  logPath,
  { followHandoffs = false } = {}
) {
  const target = new URL(origin)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/')
    throw new Error('The upgrade test transport must use its own loopback HTTP server')
  const pauseArgument = child.spawnargs.find(argument =>
    argument.startsWith('--inspect-brk=127.0.0.1:')
  )
  if (!pauseArgument) throw new Error('Upgrade transport requires a driver-paused child')
  const log = (...details) => {
    console.log(...details)
    if (!logPath) return
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(details)}\n`)
    } catch (error) {
      console.error('[desktop-e2e-inspector] Cannot retain transport diagnostics:', error.code)
    }
  }
  const socketUrl = await inspectBeforeStart(
    child,
    url => upgradeTransportScript(origin, pauseArgument, followHandoffs ? new URL(url).port : null),
    log
  )
  return new URL(socketUrl).port
}

export async function routeRunningUpgradeRequests(port, pid, origin) {
  await inspectRunningApp(port, pid, upgradeTransportScript(origin, null, port))
}

export function upgradeTransportScript(origin, pauseArgument, inspectorPort = null) {
  return `(() => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const {app, session, dialog} = require('electron')
    const pauseArgument = ${JSON.stringify(pauseArgument)}
    const inspectorArgument = ${JSON.stringify(inspectorPort ? `--inspect=127.0.0.1:${inspectorPort}` : null)}
    const forwarded = args => [
      ...args.filter(argument => argument !== pauseArgument &&
        (!inspectorArgument || !argument.startsWith('--inspect='))),
      ...(inspectorArgument ? [inspectorArgument] : [])
    ]
    const launchArguments = forwarded(process.argv.slice(1))
    process.argv = [process.argv[0], ...launchArguments]
    process.execArgv = process.execArgv.filter(argument => argument !== pauseArgument)
    app.commandLine.removeSwitch('inspect-brk')
    // Electron caches its initial arguments for relaunch. Remove only the pause
    // switch introduced by this driver, including from an explicit handoff.
    const relaunch = app.relaunch.bind(app)
    app.relaunch = options => relaunch({
      ...options,
      args: forwarded(options?.args ?? launchArguments)
    })
    if (${Boolean(process.env.WEWORK_UPGRADE_DIAGNOSTIC_CHECKPOINT)}) {
      // Startup failures can occur before product logging is initialized. Keep
      // the native error dialog and retain its exact message in CI diagnostics.
      const showErrorBox = dialog.showErrorBox.bind(dialog)
      dialog.showErrorBox = (title, content) => {
        console.error('[desktop-e2e-startup-error]', JSON.stringify({title, content}))
        return showErrorBox(title, content)
      }
      const report = () => console.log('[desktop-e2e-startup]', JSON.stringify({
        pid: process.pid, ready: app.isReady(), userData: app.getPath('userData')
      }))
      report()
      const timer = setInterval(report, 5000)
      timer.unref()
      app.once('ready', report)
      app.once('will-quit', () => clearInterval(timer))
    }
    const install = () => session.defaultSession.webRequest.onBeforeRequest(
      {urls:[${JSON.stringify(publishedBase + '*')}]},
      (request, callback) => callback({redirectURL:
        ${JSON.stringify(origin + '/')} + request.url.slice(${publishedBase.length})})
    )
    if (app.isReady()) install()
    // Join the same promise before application code registers its first fetch.
    // Electron can resolve it before notifying ready-event observers.
    else app.whenReady().then(install)
  })()`
}
