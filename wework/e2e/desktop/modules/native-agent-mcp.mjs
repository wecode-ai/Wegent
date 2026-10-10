import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

import { stopProcessGroup } from '../process-lifecycle.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  readRequestBody,
  requestContainsToolOutput,
  requestToolSearchResults,
  responseCompleted,
  responseCreated,
  selectMcpTool,
} from './response-protocol.mjs'

// The real container HTTP entrypoint runs without callbacks in this isolated probe.
// Only the model is simulated; MCP startup/calls, native sessions and files are real.
export async function verifyNativeAgentMcp({ fixture, resultDir, explicitWorkbench = false }) {
  assert.ok(
    process.env.WEWORK_E2E_EXECUTOR_BIN,
    'The shared runner must provide the built Executor'
  )
  const root = await mkdtemp(join(resultDir, 'native-agent-mcp-'))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  const probePath = join(root, 'probe.json')
  const executorHome = join(root, 'legacy-executor')
  const workbench = explicitWorkbench
    ? join(root, 'custom-workbench')
    : join(home, '.wegent/workbench')
  const agentHome = join(workbench, 'agents/synthetic/default/MCP Agent')
  let active,
    modelFailure,
    processFailure,
    output = ''
  const model = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST')
      const body = await readRequestBody(request)
      assert.ok(active)
      assert.ok(JSON.stringify(body).includes(active.prompt))
      assert.ok(
        !JSON.stringify(body).includes('wegent_member_1'),
        'Single-agent execution unexpectedly injected a legacy coordinate role'
      )
      const id = `native-mcp-${active.index}`
      let events
      if (requestContainsToolOutput(body, `${id}-call`)) {
        const result = body.input.find(
          item => item.call_id === `${id}-call` && item.type?.endsWith('_call_output')
        )
        assert.ok(JSON.stringify(result).includes(`MCP_CONTEXT:${active.token}`))
        active.called = true
        const message = assistantMessage(active.completion)
        events = [message, responseCompleted(id, [message.item])]
      } else if (requestContainsToolOutput(body, `${id}-search`)) {
        const namespace = requestToolSearchResults(body).find(
          tool =>
            tool.type === 'namespace' && tool.tools?.some(item => item.name === 'probe_environment')
        )
        assert.ok(namespace, 'Retained MCP was not found by native tool search')
        const tool = selectMcpTool(body, namespace.name, 'probe_environment', {})
        events = [
          ...namespacedFunctionCall(`${id}-call`, tool.namespace, tool.name, {}),
          responseCompleted(id),
        ]
      } else {
        events = [
          ...mcpToolRequestEvents(body, {
            toolName: 'probe_environment',
            argumentsValue: {},
            directToolName: 'mcp__retained__probe_environment',
            searchCallId: `${id}-search`,
            toolCallId: `${id}-call`,
          }).events,
          responseCompleted(id),
        ]
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...events]))
    } catch (error) {
      modelFailure = error
      response.writeHead(500)
      response.end('Native MCP verification failed')
    }
  })
  const env = Object.fromEntries(
    Object.entries(fixture.environment).filter(
      ([key, value]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key) && value != null
    )
  )
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    WEGENT_EXECUTOR_HOME: executorHome,
    ...(explicitWorkbench ? { WEGENT_WORKBENCH_HOME: workbench } : {}),
    WEGENT_CODEX_HOME: join(home, 'default-codex'),
    CODEX_HOME: join(home, 'default-codex'),
    CODEX_SQLITE_HOME: join(home, 'default-codex'),
    CODEX_BINARY_PATH: fixture.codexBinary,
    WEGENT_CLAUDE_HOME: join(home, 'unused-claude'),
    CLAUDE_CONFIG_DIR: join(home, 'unused-claude'),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    EXECUTOR_MODE: 'docker',
    HOST: '127.0.0.1',
    PORT: '0',
    WEGENT_EXECUTOR_DISABLE_FILE_LOG: 'true',
    WEGENT_DEBUG_CLAUDE_STDOUT: 'true',
    CALLBACK_URL: '',
  })
  const source = join(root, 'remote', 'demo')
  await mkdir(source, { recursive: true })
  const repositoryKey = `demo-${createHash('sha256')
    .update(`file:${toNamespacedPath(await realpath(source))}`)
    .digest('hex')
    .slice(0, 8)}`
  const workspace = join(home, '.wegent', 'workspace', repositoryKey)
  await writeFile(join(source, 'README.md'), 'synthetic workspace repository\n')
  for (const args of [
    ['init'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=Workspace Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'initial',
    ],
    ['branch', 'requested'],
  ]) {
    await promisify(execFile)('git', ['-C', source, ...args], { env, timeout: 10_000 })
  }
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const modelUrl = `http://127.0.0.1:${model.address().port}`
  const child = spawn(process.env.WEWORK_E2E_EXECUTOR_BIN, [], {
    cwd: fixture.workspace,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.on('error', error => {
    processFailure = error
  })
  child.on('exit', (code, signal) => {
    processFailure = new Error(`Executor exited: ${code}/${signal}`)
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', data => {
      output += data.toString()
    })
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (modelFailure) throw modelFailure
      if (processFailure) throw processFailure
      if (condition()) return
      await delay(50)
    }
    throw new Error(`${message}; evidence: ${root}`)
  }
  const probes = []
  let firstContent, firstStat, systemInode, firstThread
  try {
    await waitFor(() => /listening on 127\.0\.0\.1:\d+/.test(output), 'Executor did not start')
    const port = output.match(/listening on 127\.0\.0\.1:(\d+)/)[1]
    for (let index = 1; index <= 3; index++) {
      const subtask = String(61000 + index)
      active = {
        index,
        token: `synthetic-mcp-secret-${index}`,
        prompt: `NATIVE_MCP_TURN_${index}`,
        completion: `NATIVE_MCP_DONE_${index}`,
        called: false,
      }
      const mcp =
        index === 1
          ? {
              retained: {
                type: 'stdio',
                command: process.execPath,
                args: [
                  fileURLToPath(new URL('./native-mcp-environment.mjs', import.meta.url)),
                  '--stdio-env-server',
                  'first',
                  probePath,
                  'probe_environment',
                ],
                env: { TOKEN: '${{auth_token}}', ELECTRON_RUN_AS_NODE: '1' },
              },
            }
          : {}
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: active.prompt,
          background: true,
          model_config: {
            model: 'openai',
            model_id: 'gpt-5.4',
            base_url: `${modelUrl}/v1`,
            api_key: 'synthetic-model-key',
            api_format: 'responses',
          },
          metadata: {
            task_id: '61000',
            subtask_id: subtask,
            team_id: 610,
            team_name: 'MCP Agent',
            team_namespace: 'default',
            team_owner: { kind: 'user', id: 61, name: 'synthetic' },
            user_id: 61,
            user_name: 'synthetic',
            backend_url: modelUrl,
            auth_token: active.token,
            mode: 'single',
            bot: [{ id: 611, shell_type: 'Codex', mcp_servers: mcp }],
            git_url: source,
            branch_name: 'requested',
            new_session: index === 1,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).status, 'queued')
      let finished
      await waitFor(() => {
        finished = output
          .split('\n')
          .find(
            line =>
              line.includes('background task finished') && line.includes(`subtask_id=${subtask}`)
          )
        return Boolean(finished)
      }, `Native turn ${index} did not finish`)
      assert.ok(finished.includes('outcome=completed'), finished)
      assert.equal(active.called, true)
      const nativeEvents = (
        await readFile(join(root, `wegent-codex-stdout-61000-${subtask}.jsonl`), 'utf8')
      )
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      assert.equal(
        nativeEvents.some(
          event =>
            event.method === 'configWarning' && /agent role/i.test(event.params?.summary ?? '')
        ),
        false,
        'Real Codex rejected the generated agent configuration'
      )
      assert.ok(nativeEvents.some(event => event.result?.codexHome === agentHome))
      await assert.rejects(stat(join(executorHome, 'workbench')), { code: 'ENOENT' })
      if (explicitWorkbench) {
        await assert.rejects(stat(join(home, '.wegent/workbench')), { code: 'ENOENT' })
      }
      assert.ok(
        output
          .split('\n')
          .some(
            line =>
              line.includes('codex app-server starting') &&
              line.includes(`subtask_id=${subtask}`) &&
              line.includes(`cwd=${workspace}`)
          ),
        'Native Codex must execute in the unified workspace'
      )
      assert.equal(
        await readFile(join(workspace, 'README.md'), 'utf8'),
        'synthetic workspace repository\n'
      )
      const fileResponse = await fetch(
        `http://127.0.0.1:${port}/filesystem/file?path=${encodeURIComponent(`/workspace/${repositoryKey}/README.md`)}`,
        {
          signal: AbortSignal.timeout(10_000),
        }
      )
      assert.equal(fileResponse.status, 200)
      assert.equal(await fileResponse.text(), 'synthetic workspace repository\n')
      const treeResponse = await fetch(
        `http://127.0.0.1:${port}/filesystem/list-dir?path=/workspace/61000`,
        { signal: AbortSignal.timeout(10_000) }
      )
      assert.equal(treeResponse.status, 200)
      const tree = await treeResponse.json()
      assert.ok(tree.some(entry => entry.path === `/workspace/${repositoryKey}/README.md`))
      const branch = await promisify(execFile)('git', ['-C', workspace, 'symbolic-ref', 'HEAD'], {
        env,
        timeout: 10_000,
      })
      assert.equal(branch.stdout.trim(), index === 1 ? 'refs/heads/requested' : 'refs/heads/active')
      if (index === 1) {
        await writeFile(join(workspace, 'uncommitted.txt'), 'retained across turns')
        await promisify(execFile)('git', ['-C', workspace, 'checkout', '-b', 'active'], {
          env,
          timeout: 10_000,
        })
      } else
        assert.equal(
          await readFile(join(workspace, 'uncommitted.txt'), 'utf8'),
          'retained across turns'
        )
      const resumed = output
        .split('\n')
        .find(
          line =>
            line.includes('codex thread request finished') && line.includes(`subtask_id=${subtask}`)
        )
      assert.ok(resumed, 'Native thread completion was not recorded')
      const thread = resumed.match(/thread_id=([^\s]+)/)?.[1]
      assert.ok(thread)
      if (index === 1) firstThread = thread
      else {
        assert.equal(thread, firstThread)
        assert.ok(resumed.includes('operation=thread/resume'))
      }
      const probe = JSON.parse(await readFile(probePath, 'utf8'))
      assert.equal(probe.token, active.token)
      probes.push({ turn: index, thread, pid: probe.pid, contextRefreshed: true })
      const path = join(agentHome, 'config.toml')
      const content = await readFile(path, 'utf8')
      assert.ok(content.includes('[mcp_servers.retained]'))
      assert.ok(!content.includes('synthetic-mcp-secret-'))
      const metadata = await stat(path, { bigint: true })
      const system = await stat(join(agentHome, 'skills/.system'), { bigint: true })
      if (index === 1) {
        firstContent = content
        firstStat = metadata
        systemInode = system.ino
      } else {
        assert.equal(content, firstContent)
        assert.equal(metadata.ino, firstStat.ino)
        assert.equal(metadata.mtimeNs, firstStat.mtimeNs)
        assert.equal(system.ino, systemInode)
      }
    }
    const evidence = {
      passed: true,
      home: agentHome,
      stableMcpPath: join(agentHome, 'config.toml'),
      turns: probes,
      omittedMcpRetained: true,
      configUnchanged: true,
      nativeSystemSkillsPreserved: true,
      workspace,
      logicalFileApiVerified: true,
      taskTreeAliasVerified: true,
      uncommittedFilesPreserved: true,
      currentBranchPreserved: true,
      explicitWorkbench,
      executorHomeIndependent: true,
      singleAgentConfigurationAccepted: true,
    }
    await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    return evidence
  } finally {
    await stopProcessGroup(child)
    await writeFile(join(root, 'executor.log'), output, { mode: 0o600 })
    model.closeAllConnections()
    await new Promise(resolve => model.close(resolve))
  }
}
