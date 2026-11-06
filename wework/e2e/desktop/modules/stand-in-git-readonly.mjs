// Local live-provider extension: real CLI account/API, with only model responses simulated.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { requestExecutor } from './executor-rpc.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const MARKER = 'GIT_READONLY_RESTART_VERIFICATION'
const REMOVAL_MARKER = 'GIT_REMOVE_CONNECTION_PROPOSAL_VERIFICATION'
const PROVIDER = '@wegent/dsh-connection-git/github'

export function createGitReadonlyVerification({
  request,
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  let restart
  let round = 0
  let readCompleted = false
  let live
  const rpc = (control, method, params, timeoutMs = uiTimeoutMs) =>
    requestExecutor(control, method, params, timeoutMs)
  async function waitFor(read, ready) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await read()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`Git readonly work did not reach its expected state: ${JSON.stringify(latest)}`)
  }
  return {
    async prepareApp({ appEnvironment, codexHome }) {
      const repository = process.env.WEWORK_GIT_READONLY_REPOSITORY?.trim()
      if (!repository) return
      assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
      const { stdout } = await promisify(execFile)('which', ['gh'])
      const executable = stdout.trim()
      assert.ok(executable.startsWith('/'), 'Live verification requires the installed GitHub CLI')
      const cliHome = homedir()
      const configDirectory =
        process.env.GH_CONFIG_DIR ||
        join(process.env.XDG_CONFIG_HOME || join(cliHome, '.config'), 'gh')
      const bin = join(dirname(codexHome), 'git-readonly-bin')
      await mkdir(bin, { recursive: true })
      // Keep the fixture Home isolated while the real CLI uses this device's native login.
      // This guard never fabricates a response and refuses every publication operation.
      const script = `#!${process.execPath}
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
const expected = ['api', '--include', '--hostname', 'github.com', '--method', 'GET']
const read = args.length === 7 && expected.every((value, i) => args[i] === value)
  && ${JSON.stringify(['user', `repos/${repository}`, `repos/${repository}/events?per_page=100&page=1`])}.includes(args[6])
const version = args.length === 1 && ['--version', 'version'].includes(args[0])
if (!read && !version) {
  console.error('Live GitHub verification permits only identity, selected-repository and selected-repository activity GET requests')
  process.exit(64)
}
const child = spawn(${JSON.stringify(executable)}, args, {
  env: { ...process.env, HOME: ${JSON.stringify(cliHome)}, GH_CONFIG_DIR: ${JSON.stringify(configDirectory)} },
  stdio: 'inherit'
})
child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`
      await writeFile(join(bin, 'gh'), script, { mode: 0o700 })
      await promisify(execFile)(join(bin, 'gh'), ['--version'])
      const quotedBin = `'${bin.replaceAll("'", "'\\''")}'`
      const profile = `\nexport PATH=${quotedBin}:"$PATH"\n`
      for (const name of ['.zprofile', '.bash_profile'])
        await appendFile(join(appEnvironment.HOME, name), profile, { mode: 0o600 })
      appEnvironment.ZDOTDIR = appEnvironment.HOME
      appEnvironment.PATH = `${bin}:${appEnvironment.PATH || process.env.PATH || ''}`
    },
    setRestartDesktopApp(value) {
      restart = value
    },
    async handleHttp(req, response, url) {
      if (!live || req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (input.includes('Review this silent intake batch')) {
        const readId = `git-intake-${round}`
        const actionId = `git-arrange-${round}`
        if (requestContainsToolOutput(body, actionId)) {
          assert.equal(JSON.parse(readMcpToolOutput(body, actionId)).status, 'pending')
          events = [assistantMessage('已安排只读验证。')]
          round++
        } else if (requestContainsToolOutput(body, readId)) {
          const snapshot = JSON.parse(readMcpToolOutput(body, readId)).snapshot
          const event = snapshot.events.find(item => item.kind === 'connection')
          events = event
            ? mcpToolRequestEvents(body, {
                toolName: 'create_work',
                directToolName: 'mcp__wework_stand_in__create_work',
                argumentsValue: {
                  eventIds: [event.id],
                  roleId: event.roleIds[0],
                  title: 'GitHub 只读验证',
                },
                searchCallId: `git-arrange-search-${round}`,
                toolCallId: actionId,
              }).events
            : [assistantMessage('没有新的 GitHub 工作。')]
        } else
          events = mcpToolRequestEvents(body, {
            toolName: 'read_intake',
            directToolName: 'mcp__wework_stand_in__read_intake',
            argumentsValue: {},
            searchCallId: `git-intake-search-${round}`,
            toolCallId: readId,
          }).events
      } else if (input.includes(REMOVAL_MARKER)) {
        if (requestContainsToolOutput(body, 'git-live-remove-proposal')) {
          const proposal = JSON.parse(readMcpToolOutput(body, 'git-live-remove-proposal'))
          assert.equal(proposal.status, 'pending')
          events = [assistantMessage('已准备移除验证连接的提案，请确认。')]
        } else if (requestContainsToolOutput(body, 'git-live-profile')) {
          const settings = JSON.parse(readMcpToolOutput(body, 'git-live-profile'))
          const role = settings.roles.find(row => row.id === live.roleId)
          assert.ok(role, 'The readonly role must still exist')
          role.connections = role.connections.filter(
            row => row.subscriptionId !== live.subscriptionId
          )
          events = mcpToolRequestEvents(body, {
            toolName: 'propose_profile',
            directToolName: 'mcp__wework_stand_in__propose_profile',
            argumentsValue: { summary: '移除验证用仓库连接', settings },
            searchCallId: 'git-live-proposal-search',
            toolCallId: 'git-live-remove-proposal',
          }).events
        } else
          events = mcpToolRequestEvents(body, {
            toolName: 'get_profile',
            directToolName: 'mcp__wework_stand_in__get_profile',
            argumentsValue: {},
            searchCallId: 'git-live-profile-search',
            toolCallId: 'git-live-profile',
          }).events
      } else if (input.includes(MARKER)) {
        if (requestContainsToolOutput(body, 'git-live-denied-write')) {
          const result = readMcpToolOutput(body, 'git-live-denied-write')
          assert.equal(
            result,
            'user rejected MCP tool call',
            'The native result must explicitly report user rejection'
          )
          assert.ok(
            !result.includes('canonicalEventId'),
            'A denied write must not produce an outgoing receipt'
          )
          events = [assistantMessage('只读验证完成；已取消外部写入。')]
        } else if (requestContainsToolOutput(body, 'git-live-read')) {
          const result = JSON.parse(readMcpToolOutput(body, 'git-live-read'))
          assert.equal(result.data.full_name, live.repository)
          assert.equal(result.profile, live.identity.profile)
          readCompleted = true
          events = mcpToolRequestEvents(body, {
            toolName: 'git_write',
            directToolName: 'mcp__wework_stand_in__git_write',
            argumentsValue: {
              requestId: 'git-live-denied-write',
              instance: live.identity.instance,
              accountId: live.identity.accountId,
              repository: live.repository,
              method: 'POST',
              path: 'issues/1/comments',
              body: { body: 'This verification write must be denied and never published.' },
            },
            searchCallId: 'git-live-write-search',
            toolCallId: 'git-live-denied-write',
          }).events
        } else
          events = mcpToolRequestEvents(body, {
            toolName: 'git_read',
            directToolName: 'mcp__wework_stand_in__git_read',
            argumentsValue: { operation: 'repository' },
            searchCallId: 'git-live-read-search',
            toolCallId: 'git-live-read',
          }).events
      } else return false
      const id = `git-readonly-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control, userId) {
      const repository = process.env.WEWORK_GIT_READONLY_REPOSITORY?.trim()
      if (!repository) return
      assert.ok(restart, 'Live readonly verification needs the shared restart lifecycle')
      // A bound provider read performs up to two real CLI requests, each bounded at 45s.
      const identity = await rpc(
        control,
        'runtime.connections.git.read',
        {
          providerId: PROVIDER,
          instance: 'https://github.com',
          operation: 'identity',
        },
        90_000
      )
      const repo = await rpc(
        control,
        'runtime.connections.git.read',
        {
          providerId: PROVIDER,
          instance: identity.instance,
          profile: identity.profile,
          operation: 'repository',
          repository,
        },
        90_000
      )
      assert.equal(repo.data.full_name, repository)
      live = { identity, repository }
      let original = await rpc(control, 'runtime.stand_in.personal.get', { userId })
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
      assert.ok(model, 'Readonly work requires the real Codex runtime')
      const source = {
        providerId: PROVIDER,
        profile: identity.profile,
        id: String(repo.data.id),
        name: repository,
        kind: 'repository',
        policy: { automatic: true, askBeforeAct: true, immediate: false },
      }
      const activity = await rpc(
        control,
        'runtime.connections.git.read',
        {
          providerId: PROVIDER,
          instance: identity.instance,
          profile: identity.profile,
          operation: 'repository_events',
          repository,
        },
        90_000
      )
      assert.ok(
        Array.isArray(activity.data),
        'The real repository activity endpoint must return a page'
      )
      assert.equal(activity.profile, identity.profile)
      console.log('[desktop-e2e-git] real selected-repository activity GET passed')
      const beforeCli = await request('/v1/git-connections/subscriptions')
      try {
        const cliSettings = await rpc(
          control,
          'runtime.stand_in.personal.save',
          {
            userId,
            settings: {
              ...original,
              primary: { ...original.primary, enabled: false, prompt: '', preferences: '', model },
              roles: [
                {
                  ...original.roles[0],
                  name: 'CLI 只读连接验证',
                  enabled: false,
                  prompt: '',
                  model,
                  connections: [{ ...source, transport: 'cli' }],
                },
              ],
            },
          },
          180_000
        )
        const cli = cliSettings.roles[0].connections[0]
        assert.equal(cli.transport, 'cli')
        assert.equal(cli.subscriptionId, undefined)
        assert.equal(cli.generation, undefined)
        assert.equal(cli.boundary, undefined)
        const afterCli = await request('/v1/git-connections/subscriptions')
        assert.deepEqual(
          afterCli.items.map(row => row.id).sort(),
          beforeCli.items.map(row => row.id).sort(),
          'A real CLI repository source must not create a cloud receiver'
        )
        console.log(
          '[desktop-e2e-git] real selected-repository activity GET and CLI source save without cloud receiver passed'
        )
      } finally {
        const latest = await rpc(control, 'runtime.stand_in.personal.get', { userId })
        original = await rpc(
          control,
          'runtime.stand_in.personal.save',
          { userId, settings: { ...original, version: latest.version } },
          180_000
        )
      }
      // Saving preflights the source and revalidates it before creating the cloud receiver.
      // Its multiple real provider requests must not use the ordinary 10s UI step budget.
      const saved = await rpc(
        control,
        'runtime.stand_in.personal.save',
        {
          userId,
          settings: {
            ...original,
            processing: { mode: 'silent', intervalMinutes: 1 },
            primary: { ...original.primary, enabled: true, prompt: '', preferences: '', model },
            roles: [
              {
                ...original.roles[0],
                name: 'GitHub 只读验证',
                enabled: true,
                prompt: MARKER,
                model,
                connections: [source],
              },
            ],
          },
        },
        300_000
      )
      const connection = saved.roles[0].connections[0]
      live.roleId = saved.roles[0].id
      live.subscriptionId = connection.subscriptionId
      const binding = { deviceId: saved.executionDeviceId, generation: connection.generation }
      const base = `/v1/git-connections/subscriptions/${connection.subscriptionId}`
      try {
        const configuration = await request(`${base}/configuration`, 'POST', {
          ...binding,
          reveal: true,
        })
        await restart({
          afterStop: async () => {
            const payload = JSON.stringify({
              repository: { id: repo.data.id, full_name: repository },
              title: MARKER,
            })
            const headers = {
              'x-github-event': 'wework_readonly_verification',
              'x-github-delivery': 'live-offline-delivery',
              'x-hub-signature-256': `sha256=${createHmac('sha256', configuration.secret).update(payload).digest('hex')}`,
            }
            await request(
              `/v1/git-connections/hooks/${connection.subscriptionId}`,
              'POST',
              payload,
              200,
              headers
            )
            const listed = await request('/v1/git-connections/subscriptions')
            assert.equal(
              listed.items.find(row => row.id === connection.subscriptionId).pendingCount,
              1,
              'Cloud must buffer the event while the execution device is stopped'
            )
            assert.equal(
              readCompleted,
              false,
              'An offline execution device cannot run the readonly work'
            )
          },
        })
        await control.command('waitFor', '[data-testid="personal-stand-in-button"]')
        const status = await waitFor(
          () => rpc(control, 'runtime.stand_in.processing.status', { userId }),
          row => row.pendingCount > 0 || row.running || readCompleted
        )
        if (status.pendingCount > 0 && !status.running)
          await rpc(control, 'runtime.stand_in.processing.check', { userId })
        const works = await waitFor(
          () => rpc(control, 'runtime.stand_in.work.list', { userId }),
          rows =>
            rows.items?.some(
              row => row.source?.subscriptionId === connection.subscriptionId && row.taskId
            )
        )
        const work = works.items.find(
          row => row.source.subscriptionId === connection.subscriptionId
        )
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
        await control.command(
          'clickWhenEnabled',
          `[data-testid="stand-in-activity-task-${work.taskId}"]`
        )
        await control.command('waitFor', '[data-testid="stand-in-work-open-pending"]', {
          timeoutMs: modelResponseTimeoutMs,
        })
        await control.command('click', '[data-testid="stand-in-work-open-pending"]')
        await control.command('waitFor', '[data-testid="interaction-open-original"]')
        await control.command('click', '[data-testid="interaction-open-original"]')
        await control.command('waitFor', '[data-testid="request-user-input-card"]', {
          timeoutMs: modelResponseTimeoutMs,
        })
        assert.equal(
          readCompleted,
          true,
          'The restarted device must complete the account-bound native Git read'
        )
        const approval = await control.command('getText', '[data-testid="request-user-input-card"]')
        const messages = JSON.parse(
          await control.command('getRuntimeConversationMessages', 'body', {
            value: JSON.stringify({ deviceId: saved.executionDeviceId, taskId: work.taskId }),
          })
        )
        const pending = messages
          .flatMap(message => message.blocks ?? [])
          .map(block => block.renderPayload)
          .filter(payload => Array.isArray(payload?.questions))
        console.log(
          '[desktop-e2e] Native Git approval metadata',
          pending.map(payload => ({
            serverName: payload.serverName,
            approvalKind: payload.approvalKind,
            toolTitle: payload.toolTitle,
            argumentKeys: Object.keys(payload.toolArguments ?? {}),
            questionIds: payload.questions.map(question => question.id),
          }))
        )
        await captureScreenshot(
          control,
          'git-08-live-read-completed-external-write-awaiting-confirmation.png'
        )
        for (const field of [
          repository,
          identity.instance,
          String(identity.accountId),
          'POST',
          'issues/1/comments',
          'This verification write must be denied and never published.',
        ])
          assert.ok(approval.includes(field), `Native confirmation must contain ${field}`)
        const rejectText = await control.command(
          'getText',
          '[data-testid="request-user-input-option-__mcp_approval-1"]'
        )
        assert.match(
          rejectText,
          /拒绝|取消|Decline|Deny|Reject|Cancel/i,
          'Choose only the native rejection action'
        )
        await control.command(
          'clickWhenEnabled',
          '[data-testid="request-user-input-option-__mcp_approval-1"]'
        )
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: '只读验证完成；已取消外部写入。',
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, 'git-09-external-write-denied-no-publication.png')
        await rpc(control, 'runtime.stand_in.conversation', {
          userId,
          roleId: live.roleId,
          message: REMOVAL_MARKER,
        })
        await waitFor(
          () => rpc(control, 'runtime.stand_in.proposal.get', { userId, roleId: live.roleId }),
          proposal => proposal?.status === 'pending'
        )
        const beforeRemoval = await request('/v1/git-connections/subscriptions')
        assert.ok(
          beforeRemoval.items.some(row => row.id === connection.subscriptionId && row.active),
          'A removal proposal alone must not revoke the cloud receiver'
        )
        await control.command('navigate', 'body', { value: '/stand-in' })
        await control.command(
          'clickWhenEnabled',
          `[data-testid="stand-in-overview-role-${live.roleId}"]`
        )
        await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-open"]')
        await control.command('waitFor', '[data-testid="stand-in-proposal-accept"]')
        await captureScreenshot(
          control,
          'git-10-remove-connection-proposal-awaiting-confirmation.png'
        )
        await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-accept"]')
        await waitFor(
          () => rpc(control, 'runtime.stand_in.personal.get', { userId }),
          settings => settings.roles.find(row => row.id === live.roleId)?.connections?.length === 0
        )
        await waitFor(
          () => request('/v1/git-connections/subscriptions'),
          result => !result.items.some(row => row.id === connection.subscriptionId && row.active)
        )
        await waitFor(
          () => control.command('getElementCount', '[data-testid="stand-in-proposal"]'),
          count => Number(count) === 0
        )
        await captureScreenshot(control, 'git-11-accepted-removal-revokes-cloud-receiver.png')
      } finally {
        const latest = await rpc(control, 'runtime.stand_in.personal.get', { userId })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId,
          settings: { ...original, version: latest.version },
        })
      }
    },
  }
}
