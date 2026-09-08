import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { verifyDwsCloudAccount } from '../modules/dws-account-auth.mjs'
import { accountCommandResult } from '../modules/account-auth-command.mjs'

import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID, processIsAlive } from '../modules/shared.mjs'
import {
  assistantMessage,
  functionCall,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  selectTool,
} from '../modules/response-protocol.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const run = promisify(execFile)
const slug = 'desktop-account-auth'
const secret = 'synthetic-desktop-account-password'
const oauthSecret = 'synthetic-desktop-oauth-refresh'
const transferSecret = 'synthetic-desktop-transfer-refresh'
const callId = 'plugin-account-auth-business'
const prompt = 'Verify the cloud plugin account authentication business command'

async function waitForValue(read, accept, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function managedRoot(home, installedId) {
  const manifestPath = join(home, 'capabilities/manifest.json')
  const manifest = await readFile(manifestPath, 'utf8')
    .then(JSON.parse)
    .catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  const item = Object.values(manifest?.plugins ?? {}).find(
    item => item.installed_plugin_id === installedId && item.managed && item.enabled
  )
  return item ? resolve(home, 'capabilities', item.store_path) : null
}

export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  homePath,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const dwsSourceRoot = join(resultDir, 'dws-source')
  for (const name of ['config', 'keychain']) {
    await mkdir(join(dwsSourceRoot, name), { recursive: true })
  }
  let cloud
  let restartDesktopApp
  let command
  let businessWorkspace
  let toolResult = null
  const fixtureRoot = join(resultDir, slug)
  await mkdir(join(fixtureRoot, '.codex-plugin'), { recursive: true })
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true })
  await writeFile(
    join(fixtureRoot, 'scripts/legacy-auth.py'),
    'import json, sys\nassert sys.argv[1:] == ["health"], "Legacy login must not run"\nprint(json.dumps({"status":"need_login"}))\n'
  )
  await writeFile(
    join(fixtureRoot, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: slug,
      version: '1.0.0',
      description: 'Synthetic account reuse regression',
      interface: {
        displayName: 'Account authentication E2E',
        shortDescription: 'Synthetic provider',
      },
      connectors: [
        {
          slug: 'mail',
          authPolicy: 'on_install',
          localAuth: {
            kind: 'browser_oauth',
            health: ['scripts/legacy-auth.py', 'health'],
            start: ['scripts/legacy-auth.py', 'login'],
          },
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'password',
            adapter: 'scripts/account-auth.py',
          },
        },
        {
          slug: 'oauth',
          authPolicy: 'optional',
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'oauth2',
            adapter: 'scripts/oauth-auth.py',
            oauth2: ['authorize', 'refresh', 'revoke'],
          },
        },
        {
          slug: 'transfer',
          authPolicy: 'optional',
          accountAuth: {
            protocolVersion: 1,
            credentialType: 'oauth2',
            adapter: 'scripts/transfer-auth.py',
            oauth2: ['revoke'],
            exportMode: 'exclusive',
          },
        },
      ],
    })
  )
  await writeFile(
    join(fixtureRoot, 'scripts/provider.py'),
    `
import json
from pathlib import Path
def export():
    (Path.home() / "account-auth-export-attempted").write_text("attempted")
    return json.loads((Path.home() / "account-auth-synthetic.json").read_text())
def execute(credential, arguments):
    assert credential["password"] in ("${secret}", "${secret}-updated")
    print(json.dumps({"account": credential["username"], "result": "cloud-account-updated" if credential["password"].endswith("-updated") else "cloud-account-read"}))
    return 0
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/account-auth.py'),
    `
import sys
import provider
from wegent_plugin_auth import AccountAuthAdapter
adapter = AccountAuthAdapter(connector_slug="mail", credential_type="password",
    export=provider.export, account_id=lambda value:value["username"],
    execute=provider.execute, allowed_commands=("read",))
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/oauth-auth.py'),
    `
import json, os, sys, time
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter
def authorize():
    Path(${JSON.stringify(join(resultDir, 'oauth-source-executor.pid'))}).write_text(str(os.getppid()))
    return {"account":"oauth@example.test", "access_token":"synthetic-expired-access",
        "refresh_token":"${oauthSecret}", "expires_at":time.time()-1}
def refresh(credential):
    assert credential["refresh_token"] == "${oauthSecret}"
    Path(${JSON.stringify(join(resultDir, 'oauth-provider-refreshed.marker'))}).write_text(str(os.getppid()))
    return {"access_token":"synthetic-refreshed-access", "refresh_token":"${oauthSecret}-rotated", "expires_at":time.time()+3600}
def revoke(credential):
    assert credential["refresh_token"] == "${oauthSecret}-rotated"
    Path(${JSON.stringify(join(resultDir, 'oauth-provider-revoked.marker'))}).write_text("revoked")
def execute(credential, arguments):
    assert "refresh_token" not in credential
    assert credential["access_token"] == "synthetic-refreshed-access"
    print(json.dumps({"account":credential["account"], "result":"oauth-cloud-read"}))
    return 0
def export_local():
    value = json.loads((Path.home() / "account-oauth-synthetic.json").read_text())
    Path(${JSON.stringify(join(resultDir, 'oauth-source-executor.pid'))}).write_text(str(os.getppid()))
    return value
adapter = AccountAuthAdapter(connector_slug="oauth", credential_type="oauth2", export=export_local,
    account_id=lambda value:value["account"], execute=execute, allowed_commands=("read",),
    authorize=authorize, refresh=refresh, revoke=revoke)
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/oauth-cli.py'),
    `
import sys
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command
result = delegate_cloud_command(Path(__file__).resolve().parents[1], "oauth", sys.argv[1:])
assert result is not None
raise SystemExit(result)
`
  )
  const transferSource = join(homePath, 'account-transfer-synthetic.json')
  const transferReceipt = join(resultDir, 'transfer-detached.marker')
  const transferFence = join(resultDir, 'transfer-aborted.marker')
  await writeFile(
    join(fixtureRoot, 'scripts/transfer-auth.py'),
    `
import json, sys
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter, SourceChanged
source = Path(${JSON.stringify(transferSource)})
receipt = Path(${JSON.stringify(transferReceipt)})
fence = Path(${JSON.stringify(transferFence)})
def export():
    credential = json.loads(source.read_text())
    if credential["refresh_token"] == "${transferSecret}":
        rotated = {**credential, "refresh_token":"${transferSecret}-rotated"}
        source.write_text(json.dumps(rotated))
    return credential
def detach(migration_id, credential):
    if fence.exists() and fence.read_text() == migration_id:
        raise SourceChanged()
    if source.exists() and json.loads(source.read_text()) != credential:
        fence.write_text(migration_id)
        raise SourceChanged()
    assert credential["refresh_token"] == "${transferSecret}-rotated"
    if receipt.exists():
        assert receipt.read_text() == migration_id
        assert not source.exists()
        return
    assert json.loads(source.read_text()) == credential
    source.unlink()
    receipt.write_text(migration_id)
    raise RuntimeError("synthetic interruption after durable detach")
def execute(credential, arguments):
    assert "refresh_token" not in credential and "provider_private" not in credential
    assert credential["access_token"] == "synthetic-transfer-access"
    print(json.dumps({"account":credential["account"],"result":"transfer-cloud-read"}))
    return 0
adapter = AccountAuthAdapter(connector_slug="transfer", credential_type="oauth2", export=export,
    account_id=lambda value:value["account"], execute=execute, allowed_commands=("read",),
    detach=detach, revoke=lambda credential:None)
raise SystemExit(adapter.main(sys.argv[1:]))
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/transfer-cli.py'),
    `
import sys
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command
result = delegate_cloud_command(Path(__file__).resolve().parents[1], "transfer", sys.argv[1:])
assert result is not None
raise SystemExit(result)
`
  )
  await writeFile(
    join(fixtureRoot, 'scripts/cli.py'),
    `
import sys
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command
import provider
delegated = delegate_cloud_command(Path(__file__).resolve().parents[1], "mail", sys.argv[1:])
raise SystemExit(delegated if delegated is not None else provider.execute(provider.export(), sys.argv[1:]))
`
  )
  await run(
    'uv',
    ['run', '--no-project', 'python', 'sdk/plugin-auth/tool.py', 'vendor', fixtureRoot],
    { cwd: repository }
  )
  await mkdir(homePath, { recursive: true })
  await writeFile(
    transferSource,
    JSON.stringify({
      account: 'transfer@example.test',
      access_token: 'synthetic-transfer-access',
      refresh_token: transferSecret,
      provider_private: { persistent_code: transferSecret },
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
    { mode: 0o600 }
  )
  const oauthSource = join(homePath, 'account-oauth-synthetic.json')
  await writeFile(
    oauthSource,
    JSON.stringify({
      account: 'oauth@example.test',
      access_token: 'synthetic-expired-access',
      refresh_token: oauthSecret,
      expires_at: 1,
    }),
    { mode: 0o600 }
  )
  const sourceAuth = join(homePath, 'account-auth-synthetic.json')
  await writeFile(
    sourceAuth,
    JSON.stringify({ username: 'alice@example.test', password: secret }),
    { mode: 0o600 }
  )

  async function api(path, method = 'GET', body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
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
    appEnvironment: {
      DWS_CONFIG_DIR: join(dwsSourceRoot, 'config'),
      DWS_KEYCHAIN_DIR: join(dwsSourceRoot, 'keychain'),
      DWS_DISABLE_KEYCHAIN: '1',
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
      if (JSON.stringify(body).includes(prompt) && command) {
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
      await captureScreenshot(control, 'plugin-auth-transparent-detail.png', 'body')

      await waitForValue(
        () => marker(join(homePath, 'account-auth-export-attempted')),
        Boolean,
        workbenchReadyTimeoutMs,
        'Missing local authentication was not probed'
      )
      assert.equal(await connectionFor('mail'), undefined)
      await waitForValue(
        () => marker(transferFence),
        Boolean,
        workbenchReadyTimeoutMs,
        'Source-change handoff was not safely aborted'
      )
      assert.equal(await connectionFor('transfer'), undefined)
      const abortedId = await marker(transferFence)
      await writeFile(
        sourceAuth,
        JSON.stringify({ username: 'alice@example.test', password: secret }),
        { mode: 0o600 }
      )
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
      // Device grants also advance the revision; settle both grants before
      // using a revision change as proof that the source credential changed.
      const mail = await waitForValue(
        () => connectionFor('mail'),
        item =>
          [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].every(id => item?.device_ids.includes(id)),
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
      await waitForValue(
        () => connectionFor('mail'),
        item => item.revision > mail.revision,
        workbenchReadyTimeoutMs,
        'Local credential update did not propagate'
      )
      await rm(sourceAuth)
      await invokeCloud('cloud-account-updated')
      await waitForValue(
        () => connectionFor('transfer'),
        item => item?.device_ids.includes(CLOUD_DEVICE_ID),
        workbenchReadyTimeoutMs,
        'Interrupted handoff did not resume automatically'
      )
      command = `python3 ${quote(join(cloudRoot, 'scripts/transfer-cli.py'))} read`
      await invokeCloud('transfer-cloud-read')

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
            Number(await readFile(join(resultDir, 'oauth-provider-refreshed.marker'), 'utf8')),
            cloud.remoteExecutor.pid
          )
        },
      })
      await cloud.waitForConnectedAppDevice()
      const oauth = await connectionFor('oauth')
      await api(`/plugin-connections/${oauth.id}`, 'DELETE', { expected_revision: oauth.revision })
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
      await verifyDwsCloudAccount({
        cloud,
        resultDir,
        executorHome,
        api,
        waitForValue,
        managedRoot,
        timeoutMs: workbenchReadyTimeoutMs,
        invoke: async (nextCommand, expected) => {
          command = nextCommand
          await invokeCloud(expected)
        },
      })
      // Return to the visible plugin detail after a long background-only workflow.
      await control.command('click', '[data-testid="plugins-button"]')
      await control.command('waitFor', '[data-testid="plugins-workspace"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
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
        join(resultDir, 'plugin-account-auth-verification.json'),
        JSON.stringify(
          {
            noAuthorizationControls: true,
            installedWithoutSecondLogin: true,
            automaticLoginAfterInstall: true,
            automaticCredentialUpdate: true,
            automaticCloudGrant: true,
            cloudBusinessWithoutSource: true,
            exclusiveSourceChangeFenced: true,
            interruptedDetachRecoveredAutomatically: true,
            exclusiveTransferCloudExecution: true,
            sourceOfflineOAuthRefresh: true,
            oauthProviderRevocation: true,
            dwsOfficialSourceStoreAutomaticMigration: true,
            dwsUnrelatedAccountPreserved: true,
            dwsCloudExecution: true,
            deviceRevocationSurvivesAutomaticReconciliation: true,
            noCredentialLogs: true,
          },
          null,
          2
        )
      )
    },
  }
}
