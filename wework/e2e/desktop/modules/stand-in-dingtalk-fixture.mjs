import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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
  let codexHome
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const codex = (control, method, params) =>
    rpc(control, 'runtime.codex.app_server.request', { method, params })
  return {
    async prepareApp(context) {
      codexHome = context.codexHome
      const preparedBinary = process.env.WEWORK_E2E_DWS_FIXTURE_BIN
      const binary =
        preparedBinary ??
        join(resultDir, process.platform === 'win32' ? 'dws-fixture.exe' : 'dws-fixture')
      if (!preparedBinary) {
        await run('rustc', [
          fileURLToPath(new URL('../fixtures/connection-dingtalk-cli.rs', import.meta.url)),
          '--edition',
          '2021',
          '-o',
          binary,
        ])
      }
      context.appEnvironment.DWS_BINARY_PATH = binary
      await mkdir(join(root, '.agents/plugins'), { recursive: true })
      await mkdir(join(root, 'dingtalk/.codex-plugin'), { recursive: true })
      await writeFile(
        join(root, '.agents/plugins/marketplace.json'),
        JSON.stringify({
          name: 'wework',
          plugins: [{ name: 'dingtalk', source: { source: 'local', path: './dingtalk' } }],
        })
      )
      await writeFile(
        join(root, 'dingtalk/.codex-plugin/plugin.json'),
        JSON.stringify({
          name: 'dingtalk',
          version: '1.0.0',
          description: 'Isolated DingTalk protocol fixture',
          connectors: [
            {
              slug: 'dingtalk-local',
              localAuth: {
                kind: 'browser_oauth',
                health: ['health'],
                start: ['login'],
                tool: { id: 'dws', source: 'bundled' },
              },
            },
          ],
        })
      )
    },
    async install(control) {
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
