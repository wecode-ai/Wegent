/** Read delivered native instances without wrapping constructors or changing package code. */
export function nativeTrayStateScript(guid) {
  return `(async () => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const { Session } = require('node:inspector/promises')
    const session = new Session()
    const objectGroup = 'wework-upgrade-native-tray'
    session.connect()
    try {
      const prototype = await session.post('Runtime.evaluate', {
        expression: "process.getBuiltinModule('module').createRequire(process.execPath)('electron').Tray.prototype", objectGroup
      })
      const objects = await session.post('Runtime.queryObjects', {
        prototypeObjectId: prototype.result.objectId, objectGroup
      })
      const result = await session.post('Runtime.callFunctionOn', {
        objectId: objects.objects.objectId, returnByValue: true, objectGroup,
        functionDeclaration: ${JSON.stringify(`function () {
          const { screen } = process.getBuiltinModule('module').createRequire(process.execPath)('electron')
          const items = []
          for (const tray of this) {
            let destroyed
            try { destroyed = tray.isDestroyed() }
            catch (error) {
              // V8 also returns Electron's unbound native template receiver.
              if (error instanceof TypeError) continue
              throw error
            }
            if (destroyed || tray.getGUID() !== ${JSON.stringify(guid)}) continue
            const bounds = tray.getBounds()
            items.push({ guid: tray.getGUID(), bounds, display: screen.getDisplayMatching(bounds).bounds })
          }
          return { pid: process.pid, items }
        }`)}
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    } finally {
      try { await session.post('Runtime.releaseObjectGroup', { objectGroup }) }
      finally { session.disconnect() }
    }
  })()`
}
