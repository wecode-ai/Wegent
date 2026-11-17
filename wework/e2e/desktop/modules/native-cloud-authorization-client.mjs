import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { inspectRunningApp } from './inspect-before-start.mjs'
import { nativeCloudCredentialSnapshot } from './native-cloud-credential-snapshot.mjs'
import { authorizeNativeCloud } from './native-cloud-authorization.mjs'

/** Evaluate only in the current isolated Electron main process, where safeStorage exists. */
function nativeContext(userDataDirectory, operation) {
  return `(async () => {
    const require = process.getBuiltinModule('node:module').createRequire(process.execPath)
    const assert = require('node:assert/strict')
    const path = require('node:path')
    const { app } = require('electron')
    assert.equal(app.getPath('userData'), ${JSON.stringify(userDataDirectory)},
      'Native authorization escaped its isolated profile')
    assert.ok(app.isReady(), 'Native authorization requires a ready Electron host')
    const host = path.join(process.resourcesPath, 'app.asar/dist/host')
    ${operation}
  })()`
}

/** Register cleanup before authorization so a partially claimed session is restored too. */
export function nativeCloudAuthorizationFixture(cloud, userDataDirectory, control) {
  let snapshot
  const inspect = expression => {
    assert.ok(control.nativeInspectorPort, 'Native authorization requires its isolated inspector')
    return inspectRunningApp(
      control.nativeInspectorPort,
      control.applicationProcessId,
      nativeContext(userDataDirectory, expression)
    )
  }
  return {
    async authorize() {
      const directory = await inspect(`
        const { protectedCredentialDirectory } = require(path.join(host, 'credential-storage-paths.js'))
        return protectedCredentialDirectory(app.getPath('userData'))
      `)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      snapshot = nativeCloudCredentialSnapshot(directory, randomUUID())
      await snapshot.capture()
      const result = await inspect(`
        const { CloudCredentialService } = require(path.join(host, 'cloud-credential-service.js'))
        return (${authorizeNativeCloud.toString()})(
          new CloudCredentialService(app.getPath('userData'), fetch),
          ${JSON.stringify({ apiBaseUrl: `${cloud.backendUrl}/api`, authToken: cloud.authToken })},
          fetch, assert
        )
      `)
      assert.equal(result, 'authorized', 'Native cloud authorization did not complete')
    },
    restore: async () => snapshot?.restore(),
  }
}
