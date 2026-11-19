import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForBundledMarketplaceRegistration } from './plugin-flows.mjs'

const run = promisify(execFile)
const PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'

/** Keep Wework internals real and replace only the external DingTalk CLI. */
export function createStandInDingTalkFixture({ resultDir, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const root = join(resultDir, 'dingtalk-protocol-marketplace')
  const pluginRoot = join(root, 'dingtalk')
  const binaryName = process.platform === 'win32' ? 'dws-fixture.exe' : 'dws-fixture'
  const authStatePath = join(root, 'dingtalk-auth-state')
  let codexHome
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const codex = (control, method, params) =>
    rpc(control, 'runtime.codex.app_server.request', { method, params })
  return {
    async prepareApp(context) {
      codexHome = context.codexHome
      const preparedBinary = process.env.WEWORK_E2E_DWS_FIXTURE_BIN
      const binary = preparedBinary ?? join(resultDir, binaryName)
      if (!preparedBinary) {
        await run('rustc', [
          fileURLToPath(new URL('../fixtures/connection-dingtalk-cli.rs', import.meta.url)),
          '--edition',
          '2021',
          '-o',
          binary,
        ])
      }
      await mkdir(join(root, '.agents/plugins'), { recursive: true })
      await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
      await mkdir(join(pluginRoot, 'scripts'), { recursive: true })
      await writeFile(authStatePath, 'ready')
      context.appEnvironment.DWS_BINARY_PATH = binary
      context.control.performance.recordExternalServiceProtocols(['dingtalk'])
      context.appEnvironment.WEWORK_E2E_DINGTALK_AUTH_STATE = authStatePath
      await writeFile(
        join(pluginRoot, 'scripts/health.sh'),
        '#!/bin/sh\nexec "$DWS_BINARY_PATH" health\n'
      )
      await writeFile(
        join(pluginRoot, 'scripts/login.sh'),
        '#!/bin/sh\nexec "$DWS_BINARY_PATH" login\n'
      )
      await writeFile(
        join(pluginRoot, 'scripts/health.ps1'),
        '& $env:DWS_BINARY_PATH health\nexit $LASTEXITCODE\n'
      )
      await writeFile(
        join(pluginRoot, 'scripts/login.ps1'),
        '& $env:DWS_BINARY_PATH login\nexit $LASTEXITCODE\n'
      )
      await writeFile(
        join(root, '.agents/plugins/marketplace.json'),
        JSON.stringify({
          name: 'wework',
          plugins: [{ name: 'dingtalk', source: { source: 'local', path: './dingtalk' } }],
        })
      )
      await writeFile(
        join(pluginRoot, '.codex-plugin/plugin.json'),
        JSON.stringify({
          name: 'dingtalk',
          version: '1.0.0',
          description: 'Isolated DingTalk protocol fixture',
          connectors: [
            {
              slug: 'dingtalk-local',
              localAuth: {
                kind: 'browser_oauth',
                health: ['scripts/health.sh'],
                start: ['scripts/login.sh'],
                tool: { id: 'dws', source: 'bundled' },
              },
            },
          ],
        })
      )
    },
    async setAuthState(state) {
      await writeFile(authStatePath, state)
    },
    async authState() {
      return (await readFile(authStatePath, 'utf8')).trim()
    },
    async install(control) {
      await writeFile(authStatePath, 'ready')
      await waitForBundledMarketplaceRegistration(codexHome)
      const added = await codex(control, 'marketplace/add', { source: root })
      assert.equal(added.marketplaceName, 'wework')
      await requestExecutor(
        control,
        'runtime.connections.dependencies.install',
        { providerId: PROVIDER, aliases: ['dingtalk'] },
        workbenchReadyTimeoutMs
      )
      const catalog = await rpc(control, 'runtime.connections.catalog', {})
      const provider = catalog.items.find(item => item.id === PROVIDER)
      assert.equal(provider.availability.status, 'ready')
      assert.deepEqual(provider.authTarget, {
        pluginKey: 'dingtalk',
        connectorSlug: 'dingtalk-local',
      })
    },
    // The desktop runner owns teardown of this isolated app and Codex home.
  }
}
