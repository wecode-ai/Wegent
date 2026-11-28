import { personalNativeMatrix } from '../modules/personal-native-matrix.mjs'
import { readRequestBody } from '../modules/response-protocol.mjs'
import { CLAUDE_BINARY, writeText, writeToolCall } from './claude-runtime.scenario.mjs'

export async function createDesktopScenario({ captureScreenshot, resultDir, uiTimeoutMs }) {
  const matrix = personalNativeMatrix({
    captureScreenshot,
    resultDir,
    uiTimeoutMs,
    writeText,
    writeToolCall,
  })
  let cloud
  let active = false
  return {
    requiresCloudEnvironment: true,
    requiresNativeCloudAuthorization: true,
    claudeBinary: CLAUDE_BINARY,
    appEnvironment: { CLAUDE_BINARY_PATH: CLAUDE_BINARY },
    setCloudEnvironment(value) {
      cloud = value
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (!matrix.handleModel(body, response, request.headers))
        writeText(response, 'personal-auxiliary-' + Date.now(), '')
      return true
    },
    async verify(control) {
      await control.command('setLocalHarnessExecutablePaths', 'body', {
        value: JSON.stringify({ claude_code: CLAUDE_BINARY }),
      })
      active = true
      await matrix.verify(control, cloud)
    },
  }
}
