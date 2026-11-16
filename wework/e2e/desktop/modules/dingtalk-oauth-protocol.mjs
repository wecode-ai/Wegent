import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const prefix = '/dingtalk-oauth'

/** Simulate only DingTalk's OAuth service/browser; use the official unmodified CLI. */
export function createDingtalkOAuthProtocol({ resultDir, sourceRoot }) {
  const browserDirectory = join(resultDir, 'dingtalk-browser')
  const mcpUrlFile = join(sourceRoot, 'config/mcp_url')
  const requests = []
  let serverUrl
  let environment
  let authorization
  return {
    requests,
    get authorization() {
      return authorization
    },
    async prepareApp({ appEnvironment, control }) {
      serverUrl = control.url
      await mkdir(browserDirectory, { recursive: true })
      const script = `#!${process.execPath}
(async () => {
const response = await fetch(process.env.WEWORK_E2E_DINGTALK_BROWSER, {
  method: 'POST', body: JSON.stringify({authorization: process.argv[2]})
});
if (!response.ok) process.exit(1);
})().catch(() => process.exit(1));
`
      for (const name of ['open', 'xdg-open']) {
        // Browser mediation is the external OAuth boundary, never a CLI replacement.
        await writeFile(join(browserDirectory, name), script, { mode: 0o755 })
      }
      const weworkRoot = fileURLToPath(new URL('../../../', import.meta.url))
      await run(process.execPath, [join(weworkRoot, 'scripts/prepare-dws-binary.mjs')])
      const target =
        process.platform === 'darwin'
          ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
          : 'x86_64-unknown-linux-gnu'
      appEnvironment.DWS_BINARY_PATH = join(weworkRoot, 'resources/binaries', `dws-${target}`)
      appEnvironment.DWS_CLIENT_ID = ''
      appEnvironment.DWS_CLIENT_SECRET = ''
      appEnvironment.DWS_CHANNEL = ''
      appEnvironment.PATH = `${browserDirectory}${delimiter}${appEnvironment.PATH}`
      appEnvironment.WEWORK_E2E_DINGTALK_BROWSER = `${serverUrl}${prefix}/browser`
      environment = appEnvironment
    },
    async assertNoLocalLogin() {
      const result = await run(
        environment.DWS_BINARY_PATH,
        ['auth', 'status', '--format', 'json'],
        {
          env: environment,
          timeout: 10_000,
        }
      ).catch(error => {
        assert.equal(typeof error.stdout, 'string', 'Official CLI status did not run')
        return { stdout: error.stdout }
      })
      assert.match(
        result.stdout,
        /"authenticated"\s*:\s*false/,
        'The release case inherited a local login'
      )
    },
    async arm() {
      authorization = null
      await mkdir(join(sourceRoot, 'config'), { recursive: true })
      await writeFile(mcpUrlFile, `${serverUrl}${prefix}`)
    },
    async approve() {
      assert.ok(authorization, 'The real CLI did not initiate browser OAuth')
      const auth = new URL(authorization)
      assert.equal(auth.origin, 'https://login.dingtalk.com')
      const callback = new URL(auth.searchParams.get('redirect_uri'))
      assert.ok(['localhost', '127.0.0.1'].includes(callback.hostname))
      assert.equal(callback.pathname, '/callback')
      callback.searchParams.set('code', 'synthetic-e2e-authorization')
      const response = await fetch(callback, { signal: AbortSignal.timeout(10_000) })
      assert.ok(response.ok, `Official DWS callback failed: HTTP ${response.status}`)
      await response.text()
    },
    async handleHttp(request, response, url) {
      if (!url.pathname.startsWith(`${prefix}/`)) return false
      const path = url.pathname.slice(prefix.length)
      requests.push({ method: request.method, path })
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      let value
      if (path === '/browser') {
        authorization = JSON.parse(body).authorization
        value = { accepted: true }
      } else if (path === '/cli/clientId') {
        value = { success: true, result: 'synthetic-e2e-client' }
      } else if (path === '/oauth2/getToken') {
        assert.equal(JSON.parse(body).authCode, 'synthetic-e2e-authorization')
        value = {
          accessToken: 'synthetic-e2e-dingtalk-access',
          refreshToken: 'synthetic-e2e-dingtalk-refresh',
          expiresIn: 3600,
          corpId: 'synthetic-e2e-corp',
          corpName: 'Synthetic E2E corporation',
          userId: 'synthetic-e2e-user',
          userName: 'Synthetic E2E user',
        }
      } else if (path === '/cli/cliAuthEnabled') {
        // The callback has exchanged its token. Restore the standard endpoint
        // before native export; the snapshot's official-endpoint guard stays real.
        await rm(mcpUrlFile)
        value = { success: true, result: { cliAuthEnabled: true } }
      } else {
        throw new Error(`Unexpected external DingTalk protocol path: ${path}`)
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
      return true
    },
  }
}
