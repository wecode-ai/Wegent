import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  shellCommandPollResponse,
  shellCommandResponse,
} from '../modules/shell-command-response.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PROMPT = 'WEWORK_ASYNC_TURN_HOOKS'
const source = fileURLToPath(
  new URL('../../../../executor/examples/hooks/turn-diff-logger/', import.meta.url)
)
const optionalFile = async path => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

// Only model responses are simulated. The native agent, Shell, Hook dispatcher,
// plugin snapshots, detached worker and on-disk artifacts all execute for real.
export function createDesktopScenario({ resultDir, uiTimeoutMs, modelResponseTimeoutMs }) {
  let root, pluginId, rpc
  const tasks = []
  let phase = 'git'
  let activeWorkspace
  let writer
  let installed = false
  const marker = name => join(root, name)
  const waitMarker = name =>
    waitForValue(
      () => optionalFile(marker(name)),
      text => text.length > 0,
      `Hook marker ${name} was not written`,
      modelResponseTimeoutMs
    )
  const recordNames = async () => {
    try {
      return (await readdir(join(root, 'logs', 'records'))).filter(name => !name.startsWith('.'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body.input ?? []).includes(PROMPT)) return false
      const id = `async-hooks-${Date.now()}`
      const call = `write-${phase}`
      const result = accountCommandResult(body.input, call)
      let events
      if (result?.sessionId)
        events = shellCommandPollResponse(body, result.pollId, result.sessionId)
      else if (result) {
        assert.match(result.output, /HOOK_WRITES_COMPLETE/)
        events = [assistantMessage(`${PROMPT}_${phase}_DONE`)]
      } else {
        // The model fixture holds its first reply until the asynchronous baseline
        // exists, so diff assertions do not depend on the accepted startup race.
        if (phase === 'git') await waitMarker('baseline')
        const quote = value => '"' + value.replaceAll('"', '\\"') + '"'
        events = shellCommandResponse(
          body,
          call,
          `node ${quote(writer)} ${quote(activeWorkspace)}`,
          activeWorkspace
        )
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    async verify(control) {
      rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      root = await mkdtemp(join(tmpdir(), 'wework-async-hooks-'))
      let verified = false
      try {
        const workspace = join(root, 'repository')
        const plain = join(root, 'plain')
        const plugin = join(root, 'plugin')
        await mkdir(workspace)
        await mkdir(plain)
        const plainGit = spawnSync('git', ['-C', plain, 'rev-parse', '--is-inside-work-tree'], {
          encoding: 'utf8',
        })
        assert.equal(plainGit.status, 128, 'The non-Git fixture belongs to a repository')
        assert.match(plainGit.stderr, /not a git repository/i)
        const git = (...args) =>
          execFileSync('git', ['-C', workspace, ...args], {
            encoding: 'utf8',
            stdio: 'pipe',
          }).trim()
        git('init', '--quiet', '--template=')
        git('config', 'user.name', 'Hook E2E')
        git('config', 'user.email', 'hooks@example.invalid')
        git(
          'config',
          'remote.origin.url',
          'https://user:fixture-secret@example.invalid/org/repo.git?token=fixture-secret'
        )
        await writeFile(join(workspace, 'source.txt'), 'original\n')
        git('add', '.')
        git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline')
        await writeFile(join(workspace, 'source.txt'), 'dirty before\n')
        await writeFile(join(workspace, 'user.txt'), 'preexisting user file\n')
        const index = await readFile(join(workspace, '.git', 'index'))
        await cp(source, plugin, { recursive: true })
        pluginId = `async-hooks-${randomUUID()}`
        const manifestPath = join(plugin, 'plugin.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        await writeFile(manifestPath, JSON.stringify({ ...manifest, id: pluginId }))
        await writeFile(
          join(plugin, 'config.json'),
          JSON.stringify({ logDirectory: join(root, 'logs') })
        )
        const commands = JSON.parse(await readFile(join(plugin, 'hooks.json'), 'utf8'))
        for (const handlers of Object.values(commands)) {
          for (const handler of handlers)
            for (const hook of handler.hooks) {
              hook.command = './bin/fixture.mjs'
              hook.commandWindows = './bin/fixture.cmd'
              hook.async = false // Lifecycle events must remain asynchronous regardless.
            }
        }
        await writeFile(join(plugin, 'hooks.json'), JSON.stringify(commands))
        const fixture = join(plugin, 'bin', 'fixture.mjs')
        await writeFile(
          fixture,
          `#!/usr/bin/env node
import { appendFile, readFile, access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { handleEvent } from '../logger.mjs'
const root = ${JSON.stringify(root)}
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const event = JSON.parse(Buffer.concat(chunks))
const mark = name => appendFile(root + '/' + name, event.event_id + '\\n')
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)))
await mark('entered')
try {
  if (event.hook_event_name === 'TurnCompleted') {
    await mark('blocked')
    const deadline = Date.now() + 60000
    while (true) {
      try { await access(root + '/release'); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (Date.now() >= deadline) throw new Error('E2E gate was not released')
      await delay(50)
    }
  }
  await handleEvent(event, config)
  if (event.hook_event_name === 'TurnStarted') await mark('baseline')
  if (event.hook_event_name === 'ExecutionCompleted') await mark('execution-ended')
} finally { await mark('finished') }
`
        )
        await chmod(fixture, 0o755)
        await writeFile(
          join(plugin, 'bin', 'fixture.cmd'),
          '@echo off\r\nnode "%~dp0fixture.mjs"\r\n'
        )
        writer = join(root, 'write.mjs')
        await writeFile(
          writer,
          `import { writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'
const cwd = process.argv[2]
await writeFile(join(cwd, 'source.txt'), 'agent change\\n')
await writeFile(join(cwd, 'child.txt'), 'shared workspace shell write\\n')
const file = await open(join(cwd, 'large.txt'), 'w')
try { for (let i = 0; i < 160; i++) await file.writeFile('complete-generated-code-0123456789\\n'.repeat(2000)) }
finally { await file.close() }
console.log('HOOK_WRITES_COMPLETE')
`
        )
        const result = await rpc('runtime.hooks.install', { path: plugin })
        installed = true
        assert.equal(result.plugin.health.status, 'ready')
        assert.equal(result.plugin.handlers.length, 3)
        await control.command('ensureLocalModelCatalogReady', 'body', { timeoutMs: uiTimeoutMs })
        const catalog = await rpc('runtime.runner.catalog', {})
        const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
        assert.ok(model, 'No configured native Codex model')
        assert.equal(model.provider, 'wework-e2e', 'The default model must route to the fixture')
        for (const [name, cwd] of [
          ['git', workspace],
          ['plain', plain],
        ]) {
          phase = name
          activeWorkspace = cwd
          const taskId = `${pluginId}-${name}`
          tasks.push(taskId)
          await rpc('runtime.tasks.create', {
            taskId,
            title: `${PROMPT}_${name}`,
            runtime: 'codex',
            workspacePath: cwd,
            message: `${PROMPT}_${name}`,
            executionRequest: {
              task_id: taskId,
              subtask_id: `${taskId}-request`,
              user_id: 9001,
              prompt: `${PROMPT}_${name}`,
              new_session: true,
              bot: [{ shell_type: 'Codex' }],
              model_config: {
                // The Git case exercises the native thread's default model;
                // lifecycle metadata must not depend on a request override.
                ...(name === 'git' ? {} : { model_id: model.local_model_id }),
                model_provider: model.provider,
                runtime_config: { codex: { use_user_config: true, configured: true } },
              },
            },
          })
          const settled = await waitForValue(
            () => rpc('runtime.tasks.get', { taskId }),
            value => value.task?.executionState?.phase === 'idle',
            'The main agent waited for the blocked Hook',
            modelResponseTimeoutMs
          )
          assert.equal(settled.task.executionState.outcome, 'succeeded')
          if (name === 'git') {
            await waitMarker('blocked')
            assert.deepEqual(
              await recordNames(),
              [],
              'The gated Hook unexpectedly archived changes'
            )
            await writeFile(marker('release'), 'release')
            const [recordName] = await waitForValue(
              recordNames,
              names => names.length === 1,
              'No complete archive',
              modelResponseTimeoutMs
            )
            const directory = join(root, 'logs', 'records', recordName)
            const record = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8'))
            assert.equal(record.event.schema_version, 1)
            assert.ok(record.event.emitted_at_ms > 0)
            assert.equal(record.event.task_id, taskId)
            assert.equal(record.event.request_id, `${taskId}-request`)
            assert.equal(record.event.runtime_task_id, taskId)
            assert.ok(record.event.device_id)
            assert.equal(record.event.runtime, 'Codex')
            assert.ok(record.event.executor_version)
            assert.equal(record.event.model, model.local_model_id)
            assert.equal(record.event.model_provider, model.provider)
            assert.equal(record.event.user.id, '9001')
            assert.equal(record.git_url, 'https://example.invalid/org/repo.git')
            assert.doesNotMatch(JSON.stringify(record), /fixture-secret/)
            assert.equal(record.file_count, 3)
            assert.ok(record.artifacts.diff.size_bytes > 9 * 1024 * 1024)
            const files = await readFile(join(directory, 'files.jsonl'), 'utf8')
            assert.doesNotMatch(files, /user.txt/)
            assert.match(files, /child.txt/)
            const hash = createHash('sha256')
            let bytes = 0
            for await (const chunk of createReadStream(join(directory, 'diff.patch'))) {
              hash.update(chunk)
              bytes += chunk.length
            }
            assert.equal(bytes, record.artifacts.diff.size_bytes)
            assert.equal(hash.digest('hex'), record.artifacts.diff.sha256)
            assert.deepEqual(await readFile(join(workspace, '.git', 'index')), index)
          }
        }
        await waitForValue(
          () => optionalFile(marker('execution-ended')),
          text => text.trim().split('\n').length === 2,
          'Both lifecycle streams did not finish',
          modelResponseTimeoutMs
        )
        assert.equal((await recordNames()).length, 1, 'A non-Git workspace generated a change log')
        await waitForValue(
          async () => git('for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff'),
          refs => refs === '',
          'The detached worker did not release its snapshot refs',
          modelResponseTimeoutMs
        )
        verified = true
      } finally {
        // The shared server's close callback is synchronous. Drain this fixture
        // while the native executor is still available, before returning verify.
        let drained = false
        try {
          await writeFile(marker('release'), 'release')
          for (const taskId of tasks) await rpc('runtime.tasks.cancel', { taskId })
          await waitForValue(
            async () => {
              const entered = await optionalFile(marker('entered'))
              const finished = await optionalFile(marker('finished'))
              const sorted = text => text.trim().split('\n').sort().join('\n')
              return { entered: sorted(entered), finished: sorted(finished) }
            },
            value => value.entered === value.finished,
            'Hook scripts did not finish before cleanup',
            uiTimeoutMs
          )
          drained = true
        } finally {
          if (!verified || !drained) {
            try {
              // Top-level diagnostics survive runtime artifact compaction.
              const queues = await readdir(join(root, 'logs', 'queues')).catch(() => [])
              const workers = await Promise.all(
                queues.map(async id => ({
                  id,
                  log: await optionalFile(join(root, 'logs', 'queues', id, 'worker.log')),
                  pending: await readdir(join(root, 'logs', 'queues', id, 'pending')).catch(
                    () => []
                  ),
                }))
              )
              const hooks = await rpc('runtime.hooks.list', {}).catch(error => ({
                error: String(error),
              }))
              await writeFile(
                join(resultDir, 'async-hooks-diagnostics.json'),
                JSON.stringify(
                  {
                    workers,
                    runs: hooks.plugins?.find(plugin => plugin.manifest.id === pluginId)
                      ?.recentRuns,
                    error: hooks.error,
                  },
                  null,
                  2
                )
              ).catch(error => console.error('[async-hooks-diagnostics]', error))
            } catch (diagnosticError) {
              console.error('[async-hooks-diagnostics]', diagnosticError)
            }
          }
        }
        if (installed) await rpc('runtime.hooks.delete', { pluginId })
        if (!verified) await cp(root, join(resultDir, 'async-hooks-failure'), { recursive: true })
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}
