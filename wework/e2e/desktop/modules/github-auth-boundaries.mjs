import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { requestExecutor } from './executor-rpc.mjs'
import { accountCommandResult } from './account-auth-command.mjs'
import {
  assistantMessage,
  functionCall,
  latestModelInputText,
  selectShellToolCommand,
  selectTool,
} from './response-protocol.mjs'
import { ACTIVE_COMPOSER_SELECTOR } from './shared.mjs'
import { waitForWindowState } from './native-window-state.mjs'

const run = promisify(execFile)
const target = { pluginKey: 'github', connectorSlug: 'wework-github-cli' }
const manage = '[data-testid="plugin-connection-manage-connector:github"]'
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

async function directoryDigest(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async entry => {
      const path = join(root, entry.name)
      return entry.isDirectory()
        ? [entry.name, await directoryDigest(path)]
        : [
            entry.name,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]
    })
  )
  return files.sort(([left], [right]) => left.localeCompare(right))
}

export function createGithubAuthBoundaries({
  protocol,
  ghConfigDir,
  homePath,
  resultDir,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  waitForValue,
}) {
  const probes = []
  const rpc = (control, action, sessionId) =>
    requestExecutor(
      control,
      `runtime.local_connector_auth.${action}`,
      { ...target, sessionId },
      uiTimeoutMs
    )
  const wait = (read, accept, message, timeout = uiTimeoutMs) =>
    waitForValue(read, accept, timeout, message)
  const waitManage = (control, label) =>
    wait(
      async () => (await control.command('getText', manage)).trim(),
      text => text === label,
      `GitHub manage action did not become exactly ${label}`
    )
  const focus = async (control, selector, options = {}) => {
    await control.command('closeMainWindowToTray', 'body')
    await waitForWindowState(
      control,
      state => !state.visible,
      'GitHub window did not hide',
      uiTimeoutMs
    )
    await control.command('restoreMainWindow', 'body')
    await waitForWindowState(
      control,
      state => state.visible,
      'GitHub window did not return',
      uiTimeoutMs
    )
    await control.command('waitFor', selector, options)
    await control.command('closeMainWindowToTray', 'body')
  }
  const openDetail = async control => {
    const page = JSON.parse(await control.command('snapshot', 'body'))
    if (page.testIds.includes('settings-back-button')) {
      await control.command('click', '[data-testid="settings-back-button"]')
    }
    await control.command('clickWhenEnabled', '[data-testid="plugins-button"]')
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('plugin-detail-back-button'))
      await control.command('click', '[data-testid="plugin-detail-back-button"]')
    await control.command('click', '[data-testid="plugins-distribution-tab-official"]')
    await control.command('fill', '[data-testid="plugins-search-input"]', {
      value: 'GitHub CLI regression',
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="plugin-marketplace-row-github@openai-official"]'
    )
    await control.command('waitFor', manage)
  }
  const loginCard = async control => {
    await waitManage(control, '登录')
    await control.command('clickWhenEnabled', manage)
    await control.command('clickWhenEnabled', '[data-testid="github-cli-login"]')
  }
  const deviceCode = async control => {
    await control.command('waitFor', '[data-testid="github-cli-device-code"]', {
      text: 'ABCD-1234',
    })
    await control.command('waitFor', '[data-testid="github-cli-open-browser"]')
  }
  const shellProbe = async (control, phase, expectedDirectory, expectedUser) => {
    const marker = `GITHUB_${phase.toUpperCase()}_BOUNDARY_OK`
    probes.push({
      prompt: `Verify GitHub credential boundary ${phase}`,
      callId: `github-${phase}`,
      command: `test "$GH_CONFIG_DIR" = ${quote(expectedDirectory)} && test "$(gh config get user --host github.com)" = ${quote(expectedUser)} && printf '${marker}\\n'`,
      marker,
    })
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: probes.at(-1).prompt })
    await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
    await wait(
      () => probes.at(-1).output,
      output => Boolean(output?.includes(marker)),
      'Real Codex tool did not return its credential proof',
      modelResponseTimeoutMs
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${marker} completed`,
    })
    assert.ok(
      probes.at(-1).output?.includes(marker),
      'Real Codex tool did not verify the credential directory/account'
    )
    assert.equal(
      (await protocol.processes()).filter(item => item.kind === 'codex').at(-1)?.configDir,
      expectedDirectory,
      'Actual app-server process used another credential directory'
    )
  }
  return {
    handleModel(body) {
      const probe = [...probes].reverse().find(item => JSON.stringify(body).includes(item.prompt))
      if (!probe) return null
      const result = accountCommandResult(body.input, probe.callId)
      if (result?.sessionId) {
        const tool = selectTool(body, 'write_stdin', {
          session_id: result.sessionId,
          chars: '',
          yield_time_ms: 1000,
        })
        return selectedToolCall(result.pollId, tool)
      }
      if (result) {
        probe.output = result.output
        assert.ok(
          result.output.includes(probe.marker),
          `GitHub shell credential check failed: ${result.output}`
        )
        return [assistantMessage(`${probe.marker} completed`)]
      }
      assert.ok(latestModelInputText(body).includes(probe.prompt))
      const tool = selectShellToolCommand(body, probe.command)
      return selectedToolCall(probe.callId, tool)
    },
    async verify(control, { api, cloud, deviceId }) {
      // Local devices cannot be sync targets. Reuse the existing real cloud
      // Executor, sharing the Workbench store consumed by this desktop.
      Object.assign(cloud.remoteExecutorEnv, {
        WEGENT_WORKBENCH_HOME: join(homePath, '.wegent/workbench'),
        WEWORK_RUNTIME_BIN: protocol.directory,
        ...protocol.transportEnvironment,
      })
      await cloud.restartCloudExecutor()
      const user = await api('/users/me')
      const seed = async mode => {
        await run(
          'uv',
          [
            'run',
            'python',
            fileURLToPath(new URL('../fixtures/github-protocol-account.py', import.meta.url)),
            String(user.id),
            mode,
          ],
          {
            cwd: fileURLToPath(new URL('../../../../backend', import.meta.url)),
            env: cloud.backendEnv,
          }
        )
      }
      const sync = async () => {
        await seed('set')
        const result = await api(`/devices/${encodeURIComponent(deviceId)}/git-accounts`, 'PUT', {
          allow_empty: false,
        })
        assert.equal(result.status, 'synced', JSON.stringify(result))
      }
      const clearSync = async () => {
        await seed('clear')
        const result = await api(`/devices/${encodeURIComponent(deviceId)}/git-accounts`, 'PUT', {
          allow_empty: true,
        })
        assert.equal(result.status, 'synced', JSON.stringify(result))
      }
      const managed = join(homePath, '.wegent/workbench/git-auth/current/gh')
      let failure
      try {
        await openDetail(control)
        for (const [mode, text, timeout] of [
          ['missing-code', '未提供有效设备验证码', uiTimeoutMs],
          ['timeout', '未及时返回授权信息', 40_000],
        ]) {
          protocol.state.deviceMode = mode
          await loginCard(control)
          await control.command('waitFor', '[data-testid="connector-auth-retry"]', {
            timeoutMs: timeout,
          })
          assert.match(
            await control.command('getText', '[data-testid="connector-auth-card"]'),
            new RegExp(text)
          )
          assert.equal(
            JSON.parse(await control.command('snapshot', 'body')).testIds.includes(
              'github-cli-open-browser'
            ),
            false
          )
          protocol.state.deviceMode = 'normal'
          protocol.state.approved = false
          await control.command('click', '[data-testid="connector-auth-retry"]')
          await deviceCode(control)
          await control.command('click', '[data-testid="connector-auth-cancel"]')
        }
        await loginCard(control)
        await deviceCode(control)
        protocol.state.approved = true
        await waitManage(control, '退出登录')
        await shellProbe(control, 'native', ghConfigDir, 'wegent-e2e-native')
        // Catch the reviewed initial-success race using the real sync API.
        const initialGate = protocol.holdNextUser('native')
        const initial = rpc(control, 'start')
        await wait(
          () => initialGate.entered,
          Boolean,
          'Initial health never reached the GitHub protocol barrier'
        )
        await sync()
        const before = await directoryDigest(managed)
        initialGate.release()
        assert.equal((await initial).errorCode, 'gh_auth_managed')
        assert.deepEqual(await directoryDigest(managed), before)
        await shellProbe(control, 'synced', managed, 'wegent-e2e-synced')
        protocol.state.syncedValid = false
        for (const action of ['start', 'logout'])
          assert.equal((await rpc(control, action)).errorCode, 'gh_auth_managed')
        assert.deepEqual(await directoryDigest(managed), before)
        protocol.state.syncedValid = true
        await clearSync()
        await openDetail(control)
        const loggedOut = JSON.parse(
          await control.command('localConnectorAuth', 'body', {
            value: JSON.stringify({ ...target, action: 'logout' }),
          })
        )
        assert.equal(loggedOut.status, 'ok')
        await waitManage(control, '登录')
        // Device authorization completing after sync must not report native success.
        protocol.state.approved = false
        await loginCard(control)
        await deviceCode(control)
        await sync()
        const loginSnapshot = await directoryDigest(managed)
        protocol.state.approved = true
        await control.command('waitFor', '[data-testid="connector-auth-retry"]')
        assert.match(
          await control.command('getText', '[data-testid="connector-auth-card"]'),
          /账号同步管理/
        )
        assert.deepEqual(await directoryDigest(managed), loginSnapshot)
        await control.command('click', '[data-testid="connector-auth-cancel"]')
        await clearSync()
        // Pin logout across an actual sync, at its offline CLI profile lookup.
        await writeFile(
          protocol.gatePath,
          JSON.stringify({ configDir: ghConfigDir, operation: 'config get' })
        )
        const loggingOut = rpc(control, 'logout')
        await wait(
          async () =>
            readFile(`${protocol.gatePath}.entered`).then(
              () => true,
              error => {
                if (error.code === 'ENOENT') return false
                throw error
              }
            ),
          Boolean,
          'Logout never reached its real CLI barrier'
        )
        await sync()
        const logoutSnapshot = await directoryDigest(managed)
        await writeFile(`${protocol.gatePath}.released`, '')
        assert.equal((await loggingOut).errorCode, 'gh_auth_managed')
        assert.deepEqual(await directoryDigest(managed), logoutSnapshot)
        await rm(protocol.gatePath)
        await openDetail(control)
        await waitManage(control, '退出登录')
        protocol.state.apiFailure = true
        await focus(control, '[data-testid="plugin-detail-action-error"]')
        assert.match(
          await control.command('getText', '[data-testid="plugin-detail-action-error"]'),
          /无法验证 GitHub CLI 登录状态/
        )
        assert.equal((await control.command('getText', manage)).trim(), '退出登录')
        protocol.state.apiFailure = false
        await focus(control, '[data-testid="plugin-detail-action-error"]', {
          visible: false,
        })
        await control.command('navigate', 'body', { value: '/settings/git-hosting' })
        await control.command('waitFor', '[data-testid="git-hosting-cli-github-status"]', {
          text: '已就绪',
        })
        protocol.state.syncedValid = false
        await focus(control, '[data-testid="git-hosting-cli-github-status"]', {
          text: '未登录',
        })
        protocol.state.syncedValid = true
        await control.command('localConnectorAuth', 'body', {
          value: JSON.stringify({ ...target, action: 'start' }),
        })
        await control.command('waitFor', '[data-testid="git-hosting-cli-github-status"]', {
          text: '已就绪',
        })
        await openDetail(control)
        await waitManage(control, '退出登录')
        assert.deepEqual(await directoryDigest(managed), logoutSnapshot)
        await writeFile(
          join(resultDir, 'github-auth-boundaries-verification.json'),
          JSON.stringify(
            {
              protocolIntegration: true,
              realGithubOAuthVerified: false,
              nativeAndSyncedShells: probes.map(({ marker }) => marker),
              processes: await protocol.processes(),
              requests: protocol.state.requests,
              initialHealthAndLoginAndLogoutSync: true,
              managedStoreUnchanged: true,
              missingCodeAndPromptTimeoutRecovery: true,
              settingsAndDetailsRefreshed: true,
            },
            null,
            2
          )
        )
      } catch (error) {
        failure = error
        throw error
      } finally {
        protocol.state.apiFailure = false
        protocol.state.syncedValid = true
        await writeFile(`${protocol.gatePath}.released`, '')
        try {
          await clearSync()
        } catch (cleanupError) {
          if (failure)
            throw new AggregateError(
              [failure, cleanupError],
              'GitHub verification and cleanup failed'
            )
          throw cleanupError
        }
      }
    },
  }
}
