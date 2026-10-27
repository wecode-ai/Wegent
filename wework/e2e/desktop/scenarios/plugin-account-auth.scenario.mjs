import { createAccountAuthFixture } from '../modules/plugin-account-auth-fixture.mjs'
import { verifyPluginAuthCoordination } from '../modules/plugin-auth-coordination.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { verifyDwsCloudAccount } from '../modules/dws-account-auth.mjs'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { managedRoot } from '../modules/managed-plugin-root.mjs'
import {
  createConversationAuthModelFixture,
  sendOrdinaryChat,
  verifyConversationQrAuthorization,
} from '../modules/plugin-conversation-auth.mjs'
import {
  createGithubManageConnectionFixture,
  verifyGithubManageConnectionConsent,
} from '../modules/github-manage-connection.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  CLOUD_DEVICE_ID,
  REMOTE_DOCKER_DEVICE_ID,
  processIsAlive,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  functionCall,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  selectTool,
} from '../modules/response-protocol.mjs'

const run = promisify(execFile)
const slug = 'desktop-account-auth'
const secret = 'synthetic-desktop-account-password'
const oauthSecret = 'synthetic-desktop-oauth-refresh'
const transferSecret = 'synthetic-desktop-transfer-refresh'
const callId = 'plugin-account-auth-business'
const prompt = 'Verify the cloud plugin account authentication business command'
const qrPrompt = 'Verify the managed plugin conversation QR login'
const ordinaryPrompt = 'Verify ordinary chat while plugin login is pending'
const ghResumePrompt = 'Verify GitHub CLI Markdown authorization guidance'
const TRANSIENT_API_RETRY_ATTEMPTS = 50
const TRANSIENT_API_RETRY_DELAY_MS = 100

async function waitForValue(read, accept, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

export async function createDesktopScenario({
  checkpoint,
  captureScreenshot,
  executorHome,
  homePath,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const dwsSourceRoot = join(resultDir, 'dws-source')
  const ghConfigDir = join(resultDir, 'gh-config')
  await mkdir(ghConfigDir, { recursive: true })
  await run('gh', ['--version'])
  const githubConfig = await createGithubManageConnectionFixture(resultDir)
  const reconcileMarker = join(resultDir, 'plugin-account-reconcile.log')
  const retrySignal = join(resultDir, 'plugin-account-retry.signal')
  let retrySignalGeneration = 0
  const signalAutomaticRetry = () => writeFile(retrySignal, String((retrySignalGeneration += 1)))
  for (const name of ['config', 'keychain']) {
    await mkdir(join(dwsSourceRoot, name), { recursive: true })
  }
  let cloud
  let restartDesktopApp
  let command
  let businessWorkspace
  let toolResult = null
  const authModel = createConversationAuthModelFixture({ slug, qrPrompt, ghResumePrompt })
  let ordinaryRequests = 0
  const qrApproval = join(homePath, 'conversation-qr-approved')
  const fixtureRoot = join(resultDir, slug)
  const { sourceAuth, oauthSource, transferSource, transferReceipt, transferFence } =
    await createAccountAuthFixture({
      resultDir,
      homePath,
      fixtureRoot,
      slug,
      secret,
      oauthSecret,
      transferSecret,
    })

  async function api(path, method = 'GET', body) {
    let response
    for (let attempt = 1; attempt <= TRANSIENT_API_RETRY_ATTEMPTS; attempt += 1) {
      response = await fetch(`${cloud.backendUrl}/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (response.ok || ![502, 503, 504].includes(response.status)) break
      await new Promise(resolve => setTimeout(resolve, TRANSIENT_API_RETRY_DELAY_MS))
    }
    assert.ok(response.ok, `Account fixture API failed: ${method} ${path}, HTTP ${response.status}`)
    return response.json()
  }

  async function invokeCloud(expected) {
    toolResult = null
    await cloud.createPluginWorkspaceTask({
      message: prompt,
      title: 'Cloud account E2E',
      workspacePath: businessWorkspace,
    })
    await waitForValue(
      () => toolResult,
      value => value !== null,
      workbenchReadyTimeoutMs,
      'Cloud task did not execute the public plugin command'
    )
    const redactedOutput = [
      secret,
      oauthSecret,
      transferSecret,
      'synthetic-desktop-dws-access',
      'synthetic-desktop-dws-refresh',
      'synthetic-refreshed-access',
    ].reduce((output, credential) => output.replaceAll(credential, '[redacted]'), toolResult)
    await writeFile(
      join(resultDir, `plugin-account-command-${encodeURIComponent(expected)}.json`),
      JSON.stringify({ expected, output: redactedOutput }, null, 2)
    )
    assert.ok(
      toolResult.includes(expected),
      `Cloud plugin output did not contain expected result ${expected}`
    )
    assert.ok(!toolResult.includes(secret), 'Cloud business output leaked synthetic credentials')
    assert.ok(!toolResult.includes(oauthSecret), 'Cloud business output leaked OAuth credentials')
    assert.ok(
      !toolResult.includes('synthetic-desktop-dws-access') &&
        !toolResult.includes('synthetic-desktop-dws-refresh'),
      'Cloud business output leaked DWS credentials'
    )
  }

  return {
    requiresCloudEnvironment: true,
    codexConfigToml: githubConfig,
    appEnvironment: {
      GH_CONFIG_DIR: ghConfigDir,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      DWS_CONFIG_DIR: join(dwsSourceRoot, 'config'),
      DWS_KEYCHAIN_DIR: join(dwsSourceRoot, 'keychain'),
      DWS_DISABLE_KEYCHAIN: '1',
      WEWORK_E2E_PLUGIN_ACCOUNT_RECONCILE_INTERVAL_MS: '1000',
      WEWORK_E2E_PLUGIN_ACCOUNT_RECONCILE_MARKER: reconcileMarker,
      WEWORK_E2E_PLUGIN_ACCOUNT_RETRY_SIGNAL: retrySignal,
    },
    setCloudEnvironment(environment) {
      cloud = environment
    },
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const id = `account-auth-${Date.now()}`
      let events
      const requestText = JSON.stringify(body)
      const authEvents = await authModel.respond(body)
      if (authEvents) {
        events = authEvents
      } else if (latestModelInputText(body).includes(ordinaryPrompt)) {
        const message = `${ordinaryPrompt} #${ordinaryRequests + 1}`
        assert.ok(latestModelInputText(body).includes(message), 'Unexpected ordinary chat message')
        ordinaryRequests += 1
        events = [assistantMessage(`${message} completed`)]
      } else if (requestText.includes(prompt) && command) {
        const result = accountCommandResult(body.input, callId)
        if (result?.sessionId) {
          const tool = selectTool(body, 'write_stdin', {
            session_id: result.sessionId,
            chars: '',
            yield_time_ms: 1000,
          })
          events = functionCall(result.pollId, tool.name, tool.arguments)
        } else if (result) {
          toolResult = result.output
          events = [assistantMessage('Cloud account verification finished')]
        } else {
          const tool = selectShellToolCommand(body, command, businessWorkspace)
          events = functionCall(callId, tool.name, tool.arguments)
        }
      } else {
        events = [assistantMessage('Account authentication fixture ready')]
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        [responseCreated(id), ...events, responseCompleted(id)]
          .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('')
      )
      return true
    },
    async verify(control) {
      const preferences = JSON.parse(
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ replyPredictionsEnabled: false }),
        })
      )
      assert.equal(
        preferences.replyPredictionsEnabled,
        false,
        'Plugin account auth scenario must not start background reply predictions'
      )
      const local = await cloud.waitForConnectedAppDevice()
      assert.equal((await api('/plugin-connections/automation')).enabled, true)
      await rm(sourceAuth)
      const release = await cloud.publishPluginRelease({
        slug,
        version: '1.0.0',
        packageRoot: fixtureRoot,
      })
      await control.command('click', '[data-testid="plugins-button"]')
      await control.command('waitFor', '[data-testid="plugins-search-input"]')
      await control.command('fill', '[data-testid="plugins-search-input"]', { value: slug })
      await control.command(
        'waitFor',
        `[data-testid="plugin-marketplace-install-${release.pluginId}"]`,
        { timeoutMs: workbenchReadyTimeoutMs }
      )
      await control.command(
        'click',
        `[data-testid="plugin-marketplace-install-${release.pluginId}"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]')
      await control.command('waitFor', '[data-testid="plugin-operation-notice"]', {
        text: '已安装',
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await api(
        `/plugins/marketplace/${release.pluginId}/install?device_id=${CLOUD_DEVICE_ID}`,
        'POST'
      )
      const installed = (await api('/plugins/installed')).items.find(
        item => item.spec.source.pluginKey === slug
      )
      const installedId = Number(installed.metadata.labels.id)
      const cloudHome = dirname(cloud.remoteCodexHome)
      const cloudRoot = await waitForValue(
        () => managedRoot(cloudHome, installedId),
        Boolean,
        workbenchReadyTimeoutMs,
        'Cloud plugin did not synchronize'
      )
      businessWorkspace = join(cloudHome, 'Documents', 'Codex', 'plugin-account-auth')
      await mkdir(businessWorkspace, { recursive: true })
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`
      const marker = path =>
        readFile(path, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
      const connectionFor = async slug =>
        (await api('/plugin-connections')).find(
          item => item.installed_plugin_id === installedId && item.connector_slug === slug
        )
      await control.command(
        'waitFor',
        `[data-testid="plugins-installed-strip-item-${installedId}"]`,
        { timeoutMs: workbenchReadyTimeoutMs }
      )
      await control.command('click', `[data-testid="plugins-installed-strip-item-${installedId}"]`)
      const page = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        !page.testIds.some(id => id.startsWith('plugin-account-')),
        'Internal account authorization controls were exposed'
      )
      assert.ok(
        !page.testIds.includes('local-connector-auth-dialog'),
        'Install required a second authorization'
      )
      const checks = new Map([
        [
          'plugin-account-auth-coordination',
          () =>
            verifyPluginAuthCoordination({
              cloud,
              control,
              slug,
              homePath,
              installedId,
              connectionFor,
              signalAutomaticRetry,
              reconcileMarker,
              resultDir,
              timeoutMs: workbenchReadyTimeoutMs,
            }),
        ],
        [
          'plugin-account-auth-password',
          async () => {
            await control.command('waitFor', '[data-testid="plugin-connection-manage-group:sites"]')
            await control.command('click', '[data-testid="plugin-connection-manage-group:sites"]')
            await control.command('waitFor', '[data-testid="plugin-connector-source-dialog"]', {
              text: 'git.three.example',
            })
            await control.command('fill', '[data-testid="plugin-connector-source-select"]', {
              value: 'oauth',
            })
            await control.command('click', '[data-testid="plugin-connector-source-continue"]')
            // An account export declaration is not a cloud OAuth app registration.
            await control.command('waitFor', '[data-testid="plugin-detail-action-error"]', {
              text: '此连接尚未提供页面登录入口',
            })
            await control.command('waitFor', '[data-testid="plugin-connection-manage-group:sites"]')
            await control.command('click', '[data-testid="plugin-connection-manage-group:sites"]')
            await control.command('click', '[data-testid="plugin-connector-source-cancel"]')
            await captureScreenshot(control, 'plugin-auth-transparent-detail.png', 'body')

            await waitForValue(
              () => marker(join(homePath, 'account-auth-export-attempted')),
              Boolean,
              workbenchReadyTimeoutMs,
              'Missing local authentication was not probed'
            )
            assert.equal(await connectionFor('mail'), undefined)
            await writeFile(
              sourceAuth,
              JSON.stringify({ username: 'alice@example.test', password: secret }),
              { mode: 0o600 }
            )
            await signalAutomaticRetry()
            // Device grants also advance the revision; settle both grants before
            // using a revision change as proof that the source credential changed.
            const mail = await waitForValue(
              () => connectionFor('mail'),
              item =>
                [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].every(id =>
                  item?.device_ids.includes(id)
                ),
              workbenchReadyTimeoutMs,
              'Local login did not automatically reach cloud'
            )
            command = `python3 ${quote(join(cloudRoot, 'scripts/cli.py'))} read`
            await rm(sourceAuth)
            await invokeCloud('cloud-account-read')
            await writeFile(
              sourceAuth,
              JSON.stringify({ username: 'alice@example.test', password: secret + '-updated' }),
              { mode: 0o600 }
            )
            await signalAutomaticRetry()
            await waitForValue(
              () => connectionFor('mail'),
              item => item.revision > mail.revision,
              workbenchReadyTimeoutMs,
              'Local credential update did not propagate'
            )
            await rm(sourceAuth)
            await invokeCloud('cloud-account-updated')
            const localAuth = async (action, sessionId) =>
              JSON.parse(
                await control.command('localConnectorAuth', 'body', {
                  value: JSON.stringify({
                    pluginKey: slug,
                    connectorSlug: 'mail',
                    action,
                    sessionId,
                  }),
                })
              )
            // The legacy source is gone. The original entry must show the managed account.
            assert.equal((await localAuth('health')).status, 'ok')
            // A real packaged CLI failure must not undo the account revocation or
            // report that the retained local credentials have already been cleared.
            await writeFile(
              sourceAuth,
              JSON.stringify({ username: 'alice@example.test', password: secret + '-updated' }),
              { mode: 0o600 }
            )
            const failLogout = join(homePath, 'account-auth-fail-logout')
            await writeFile(failLogout, 'fail')
            try {
              await assert.rejects(
                () => localAuth('logout'),
                /local_auth_logout_failed/,
                'Failed local cleanup was reported as a successful logout'
              )
              assert.equal((await connectionFor('mail')).status, 'disconnected')
              assert.ok(await readFile(sourceAuth), 'Failed cleanup removed the local credential')
            } finally {
              await rm(failLogout)
            }
            assert.equal((await localAuth('logout')).status, 'ok')
            assert.equal(
              (await localAuth('logout')).status,
              'ok',
              'Repeated logout is not idempotent'
            )
            assert.equal((await connectionFor('mail')).status, 'disconnected')
            command = `python3 ${quote(join(cloudRoot, 'scripts/cli.py'))} read`
            await invokeCloud('plugin_auth_device_not_granted')
            assert.equal((await localAuth('health')).status, 'need_login')
            // Reopen the detail after the direct API logout to refresh its displayed auth state.
            await control.command('click', '[data-testid="plugin-detail-back-button"]')
            await control.command(
              'clickWhenEnabled',
              `[data-testid="plugins-installed-strip-item-${installedId}"]`
            )
            await control.command('waitFor', '[data-testid="plugin-connection-manage-group:sites"]')
            await control.command('click', '[data-testid="plugin-connection-manage-group:sites"]')
            await control.command('fill', '[data-testid="plugin-connector-source-select"]', {
              value: 'mail',
            })
            await waitForValue(
              () => control.command('getText', '[data-testid="plugin-connector-source-continue"]'),
              text => text.trim() === '登录',
              10000,
              'Connector detail did not refresh the logged-out account'
            )
            await control.command('click', '[data-testid="plugin-connector-source-continue"]')
            await control.command('waitFor', '[data-testid="plugin-connector-section"]', {
              text: '已连接 · git.one.example',
            })
            await waitForValue(
              () => connectionFor('mail'),
              item => item?.status === 'connected' && item.device_ids.includes(CLOUD_DEVICE_ID),
              workbenchReadyTimeoutMs,
              'Fresh login did not resume cloud authentication'
            )
            await rm(sourceAuth)
            assert.equal((await localAuth('health')).status, 'ok')
            await invokeCloud('cloud-account-updated')
          },
        ],
        [
          'plugin-account-auth-transfer',
          async () => {
            await waitForValue(
              () => marker(transferFence),
              Boolean,
              workbenchReadyTimeoutMs,
              'Source-change handoff was not safely aborted'
            )
            assert.equal(await connectionFor('transfer'), undefined)
            const abortedId = await marker(transferFence)
            await signalAutomaticRetry()
            await waitForValue(
              () => marker(transferReceipt),
              Boolean,
              workbenchReadyTimeoutMs,
              'Automatic handoff did not reach durable detach'
            )
            assert.equal(
              await connectionFor('transfer'),
              undefined,
              'Interrupted handoff activated prematurely'
            )
            assert.notEqual(await marker(transferReceipt), abortedId)
            await assert.rejects(readFile(transferSource), { code: 'ENOENT' })
            await signalAutomaticRetry()
            await waitForValue(
              () => connectionFor('transfer'),
              item => item?.device_ids.includes(CLOUD_DEVICE_ID),
              workbenchReadyTimeoutMs,
              'Interrupted handoff did not resume automatically'
            )
            command = `python3 ${quote(join(cloudRoot, 'scripts/transfer-cli.py'))} read`
            await invokeCloud('transfer-cloud-read')
          },
        ],
        [
          'plugin-account-auth-oauth',
          async () => {
            await waitForValue(
              () => connectionFor('oauth'),
              item => item?.device_ids.includes(CLOUD_DEVICE_ID),
              workbenchReadyTimeoutMs,
              'OAuth source did not automatically connect'
            )
            await rm(oauthSource)
            const sourcePids = [
              Number(await readFile(join(resultDir, 'oauth-source-executor.pid'), 'utf8')),
            ]
            assert.ok(
              sourcePids.every(pid => Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid))
            )
            command = `python3 ${quote(join(cloudRoot, 'scripts/oauth-cli.py'))} read`
            await restartDesktopApp({
              afterStop: async () => {
                await waitForValue(
                  () => sourcePids.every(pid => !processIsAlive(pid)),
                  Boolean,
                  workbenchReadyTimeoutMs,
                  'Source survived shutdown'
                )
                await cloud.waitForDeviceStatus(
                  local.device_id,
                  'offline',
                  join(resultDir, 'executor.log')
                )
                await invokeCloud('oauth-cloud-read')
                assert.equal(
                  Number(
                    await readFile(join(resultDir, 'oauth-provider-refreshed.marker'), 'utf8')
                  ),
                  cloud.remoteExecutor.pid
                )
              },
            })
            await cloud.waitForConnectedAppDevice()
            const oauth = await connectionFor('oauth')
            await api(`/plugin-connections/${oauth.id}`, 'DELETE', {
              expected_revision: oauth.revision,
            })
            await invokeCloud('plugin_auth_device_not_granted')
            await waitForValue(
              () => connectionFor('oauth'),
              item => item.provider_revocation === 'revoked',
              workbenchReadyTimeoutMs,
              'OAuth provider revocation did not finish'
            )
            assert.equal(
              await readFile(join(resultDir, 'oauth-provider-revoked.marker'), 'utf8'),
              'revoked'
            )
          },
        ],
        [
          'plugin-account-auth-dws',
          async () => {
            await verifyDwsCloudAccount({
              cloud,
              resultDir,
              executorHome,
              api,
              waitForValue,
              managedRoot,
              reconcileMarker,
              timeoutMs: workbenchReadyTimeoutMs,
              invoke: async (nextCommand, expected) => {
                command = nextCommand
                await invokeCloud(expected)
              },
            })
          },
        ],
        [
          'plugin-account-auth-conversation',
          async () => {
            await control.command('localConnectorAuth', 'body', {
              value: JSON.stringify({
                pluginKey: slug,
                connectorSlug: 'conversation-qr',
                action: 'logout',
              }),
            })
            await control.command(
              'click',
              '[data-testid="plugin-connection-manage-connector:conversation-qr"]'
            )
            await control.command('waitFor', '[data-testid="local-connector-auth-qr"]')
            const qrDetail = JSON.parse(await control.command('snapshot', 'body'))
            assert.ok(
              !qrDetail.testIds.includes('plugin-github-cli-auth-dialog'),
              'Non-GitHub connector opened GitHub login'
            )
            assert.ok(
              !qrDetail.text.includes('此插件通过对话授权 GitHub'),
              'Non-GitHub connector used GitHub authorization copy'
            )
            await captureScreenshot(control, 'plugin-auth-detail-native-qr.png', 'body')
            await control.command('click', '[data-testid="local-connector-auth-cancel"]')
            await control.command(
              'waitFor',
              '[data-testid="plugin-connection-manage-connector:conversation-qr"]:not([disabled])'
            )

            await verifyConversationQrAuthorization({
              control,
              slug,
              ordinaryPrompt,
              authModel,
              getOrdinaryRequests: () => ordinaryRequests,
              qrApproval,
              captureScreenshot,
              homePath,
              waitForValue,
              pluginRoots: await (async () => {
                const manifest = JSON.parse(
                  await readFile(join(executorHome, 'capabilities/manifest-v2.json'), 'utf8')
                )
                const item = Object.values(manifest.plugins).find(
                  item => item.installed_plugin_id === installedId
                )
                assert.ok(item, 'Local installed plugin is missing')
                return [
                  await managedRoot(executorHome, installedId),
                  resolve(executorHome, 'capabilities', item.store_path),
                ]
              })(),
            })
          },
        ],
        [
          'plugin-account-auth-github',
          async () => {
            // Real gh with an empty configuration establishes the unauthenticated
            // path without replacing a provider or minting CI account credentials.
            const ghHealth = JSON.parse(
              await control.command('localConnectorAuth', 'body', {
                value: JSON.stringify({
                  pluginKey: 'github',
                  connectorSlug: 'wework-github-cli',
                  action: 'health',
                }),
              })
            )
            assert.equal(
              ghHealth.status,
              'need_login',
              `Isolated gh health must require login: ${JSON.stringify(ghHealth)}`
            )
            await control.command('click', '[data-testid="plugin-detail-back-button"]')
            await control.command('waitFor', '[data-testid="plugins-search-input"]')
            await verifyGithubManageConnectionConsent(control, slug, release.pluginId)
            for (const action of ['cancel', 'ordinary', 'resume']) {
              await control.command('click', '[data-testid="new-chat-button"]')
              await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
              const reference =
                action === 'resume'
                  ? ''
                  : action === 'cancel'
                    ? '[$GitHub](plugin://github@openai-curated-remote) '
                    : '[$GitHub](app://connector_account_specific_id) '
              const ghDraft = `${reference}${ghResumePrompt} ${action}`
              const previousRequests = authModel.getGithubRequests()
              await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ghDraft })
              await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
              await control.command('waitFor', '[data-testid="github-cli-login"]')
              assert.equal(
                authModel.getGithubRequests(),
                previousRequests + 1,
                'GitHub authorization blocked sending instead of responding to the runtime error'
              )
              assert.equal(await control.command('getValue', ACTIVE_COMPOSER_SELECTOR), '')
              const pendingGh = JSON.parse(await control.command('snapshot', 'body'))
              assert.ok(
                !pendingGh.testIds.includes('github-cli-device-code'),
                'gh login started before consent'
              )
              if (action === 'cancel') {
                await control.command('click', '[data-testid="connector-auth-cancel"]')
                assert.equal(
                  await control.command('getValue', ACTIVE_COMPOSER_SELECTOR),
                  '',
                  'Cancelling GitHub authorization restored an already sent message'
                )
                const cancelledGh = JSON.parse(await control.command('snapshot', 'body'))
                assert.ok(
                  !cancelledGh.testIds.includes('github-cli-auth'),
                  'gh authorization card remained open after cancellation'
                )
              }
              await sendOrdinaryChat({
                control,
                ordinaryPrompt,
                getOrdinaryRequests: () => ordinaryRequests,
              })
              const recovered = JSON.parse(await control.command('snapshot', 'body'))
              assert.ok(
                !recovered.testIds.includes('github-cli-auth'),
                'Runtime GitHub authorization blocked ordinary chat'
              )
            }
            await captureScreenshot(control, 'github-cli-ordinary-chat-recovered.png', 'body')
          },
        ],
      ])
      const check = checks.get(checkpoint)
      assert.ok(check, `Unknown account authentication checkpoint: ${checkpoint}`)
      console.log(`[desktop-e2e-account] start ${checkpoint}`)
      await check()
      console.log(`[desktop-e2e-account] end ${checkpoint}`)
      // Return to the visible plugin detail after a long background-only workflow.
      await control.command('click', '[data-testid="plugins-button"]')
      const pluginPage = JSON.parse(await control.command('snapshot', 'body'))
      if (pluginPage.testIds.includes('plugin-detail-back-button')) {
        await control.command('click', '[data-testid="plugin-detail-back-button"]')
      }
      await control.command(
        'waitFor',
        `[data-testid="plugins-installed-strip-item-${installedId}"]`
      )
      await control.command('click', `[data-testid="plugins-installed-strip-item-${installedId}"]`)
      await control.command('waitFor', '[data-testid="plugin-connection-manage-group:sites"]')
      const finalPage = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(!finalPage.testIds.some(id => id.startsWith('plugin-account-')))
      await captureScreenshot(control, 'plugin-auth-automatic-complete.png', 'body')
      for (const log of [
        cloud.backendLogPath,
        cloud.remoteExecutorLogPath,
        join(resultDir, 'executor.log'),
      ]) {
        const contents = await readFile(log, 'utf8')
        for (const value of [
          secret,
          oauthSecret,
          transferSecret,
          'synthetic-desktop-dws-access',
          'synthetic-desktop-dws-refresh',
        ]) {
          assert.ok(!contents.includes(value), 'Provider credential appeared in runtime logs')
        }
      }
      await writeFile(
        join(resultDir, `${checkpoint}-verification.json`),
        JSON.stringify({ checkpoint, completed: true, noCredentialLogs: true }, null, 2)
      )
    },
  }
}
