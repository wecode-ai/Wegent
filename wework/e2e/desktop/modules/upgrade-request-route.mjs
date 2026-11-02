import { inspectBeforeStart } from './inspect-before-start.mjs'

const publishedBase = 'https://github.com/wecode-ai/Wegent/releases/download/wework-updater/'

export async function routeUpgradeRequests(child, origin) {
  const target = new URL(origin)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/')
    throw new Error('The upgrade test transport must use its own loopback HTTP server')
  await inspectBeforeStart(
    child,
    `(() => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const {app, session} = require('electron')
    const install = () => session.defaultSession.webRequest.onBeforeRequest(
      {urls:[${JSON.stringify(publishedBase + '*')}]},
      (request, callback) => callback({redirectURL:
        ${JSON.stringify(origin + '/')} + request.url.slice(${publishedBase.length})})
    )
    if (app.isReady()) install()
    else app.once('ready', install)
  })()`
  )
}
