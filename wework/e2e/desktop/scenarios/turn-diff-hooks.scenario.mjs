import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

const PLUGIN_ID = 'turn-diff-hooks-e2e'
const PHASES = ['first', 'second', 'plain']
const promptFor = phase => `WEWORK_E2E_TURN_DIFF_${phase.toUpperCase()}`
const SHELL_MARKER = 'WEWORK_E2E_TURN_DIFF_SHELL_OK'
const NEGATIVE_OBSERVATION_MS = 750
const LARGE_FILE_BYTES = 9 * 1024 * 1024
const LARGE_LINE_BYTES = 1024
const PATCH_NEEDLES = {
  firstIncrement: '-base\n+first\n',
  secondIncrement: '-first\n+second\n',
  firstFile: 'first-only.txt',
  secondFile: 'second-only.txt',
  dirtyBaseline: 'user dirty before turn',
  largeStart: '+LARGE_BEGIN\n',
  largeEnd: '+LARGE_END\n',
}

const WRITER = `import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
const [cwd, phase] = process.argv.slice(2)
const newline = String.fromCharCode(10)
writeFileSync(join(cwd, 'source.txt'), phase + newline)
writeFileSync(join(cwd, phase + '-only.txt'), phase + newline)
if (phase === 'first') {
  const file = openSync(join(cwd, 'large.txt'), 'w')
  const chunk = Buffer.from(('A'.repeat(${LARGE_LINE_BYTES - 1}) + newline).repeat(64))
  try {
    writeSync(file, 'LARGE_BEGIN' + newline)
    for (let index = 0; index < ${LARGE_FILE_BYTES / (LARGE_LINE_BYTES * 64)}; index += 1)
      writeSync(file, chunk)
    writeSync(file, 'LARGE_END' + newline)
  } finally {
    closeSync(file)
  }
}
console.log('${SHELL_MARKER}')
`

const REPORTER = `import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
const [reportsPath, archiveDir, releasePath, startedPath] = process.argv.slice(2)
let input = ''
for await (const chunk of process.stdin) input += chunk
const event = JSON.parse(input)
assert.equal(typeof event.event_id, 'string')
assert.ok(Number.isSafeInteger(event.sequence) && event.sequence >= 0)
assert.ok(!Object.hasOwn(event.file_changes, 'diff'))
assert.ok(!Object.hasOwn(event.file_changes, 'files'))
const newline = String.fromCharCode(10)
appendFileSync(startedPath, JSON.stringify({ event_id: event.event_id, turn_id: event.turn_id }) + newline)
const deadline = Date.now() + 50_000
while (!existsSync(releasePath)) {
  assert.ok(Date.now() < deadline, 'The scenario did not release the held hook')
  await delay(25)
}
await mkdir(archiveDir, { recursive: true })
const name = event.sequence + '-' + event.event_id.replace(/[^a-zA-Z0-9_-]/g, '_')
async function archive(descriptor, suffix) {
  assert.equal(typeof descriptor.path, 'string')
  assert.equal(typeof descriptor.format, 'string')
  assert.ok(Number.isSafeInteger(descriptor.size_bytes) && descriptor.size_bytes >= 0)
  assert.match(descriptor.sha256, /^[0-9a-f]{64}$/)
  const hash = createHash('sha256')
  let size = 0
  const path = join(archiveDir, name + '-' + suffix)
  await pipeline(createReadStream(descriptor.path), new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  }), createWriteStream(path))
  assert.equal(size, descriptor.size_bytes, 'An artifact was truncated')
  const sha256 = hash.digest('hex')
  assert.equal(sha256, descriptor.sha256, 'An artifact changed after its descriptor was sealed')
  return { path, size_bytes: size, sha256, format: descriptor.format }
}
const diffArtifact = await archive(event.file_changes.diff_artifact, 'changes.patch')
const filesArtifact = await archive(event.file_changes.files_artifact, 'files.jsonl')
const files = []
for await (const line of createInterface({ input: createReadStream(filesArtifact.path), crlfDelay: Infinity })) {
  if (line) files.push(JSON.parse(line).path)
}
const needles = ${JSON.stringify(PATCH_NEEDLES)}
const patchChecks = Object.fromEntries(Object.keys(needles).map(key => [key, false]))
const tailSize = Math.max(...Object.values(needles).map(value => value.length)) - 1
let tail = ''
for await (const chunk of createReadStream(diffArtifact.path)) {
  const text = tail + chunk.toString('utf8')
  for (const [key, needle] of Object.entries(needles)) patchChecks[key] ||= text.includes(needle)
  tail = text.slice(-tailSize)
}
let largeAddedLines = 0
const largeLine = '+' + 'A'.repeat(${LARGE_LINE_BYTES - 1})
for await (const line of createInterface({ input: createReadStream(diffArtifact.path), crlfDelay: Infinity })) {
  if (line === largeLine) largeAddedLines += 1
}
const report = {
  event_id: event.event_id, sequence: event.sequence, session_id: event.session_id,
  turn_id: event.turn_id, cwd: event.cwd, hook_event_name: event.hook_event_name,
  status: event.status, diff_artifact: diffArtifact, files_artifact: filesArtifact,
  files, patch_checks: patchChecks, large_added_lines: largeAddedLines,
}
appendFileSync(reportsPath, JSON.stringify(report) + newline)
`

function commandLine(args) {
  return args.map(value => `"${value.replaceAll('"', '\\"')}"`).join(' ')
}

async function reportsAt(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Real Electron -> executor -> native Codex -> shell -> Git snapshot -> hook command. */
export function createDesktopScenario({ resultDir, uiTimeoutMs, modelResponseTimeoutMs }) {
  let active = false
  let fixtureRoot
  let gitWorkspace
  let plainWorkspace
  let writerPath
  const verifiedShells = new Set()
  const reportsPath = join(resultDir, 'turn-diff-hook-reports.jsonl')
  const startedPath = join(resultDir, 'turn-diff-hook-started.jsonl')
  const releasePath = join(resultDir, 'turn-diff-hook-release')
  const archiveDir = join(resultDir, 'turn-diff-hook-archives')

  return {
    async cleanup() {
      active = false
      await writeFile(releasePath, 'release')
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = JSON.stringify(body.input ?? [])
      const phase = PHASES.map(value => ({ value, position: input.lastIndexOf(promptFor(value)) }))
        .filter(value => value.position >= 0)
        .sort((left, right) => right.position - left.position)[0]?.value
      const id = `turn-diff-${phase ?? 'warmup'}-${Date.now()}`
      let events = [assistantMessage('Ready')]
      if (phase) {
        const callId = `turn-diff-shell-${phase}`
        const result = accountCommandResult(body.input, callId)
        if (result?.sessionId) {
          events = shellCommandPollResponse(body, result.pollId, result.sessionId)
        } else if (result) {
          assert.match(result.output, /Exit code: 0|exit_code\W*0|Process exited with code 0/)
          assert.ok(
            result.output.includes(SHELL_MARKER),
            'The real shell did not finish the writes'
          )
          verifiedShells.add(phase)
          events = [assistantMessage(`${promptFor(phase)}_DONE`)]
        } else {
          const cwd = phase === 'plain' ? plainWorkspace : gitWorkspace
          events = shellCommandResponse(
            body,
            callId,
            commandLine([process.execPath, writerPath, cwd, phase]),
            cwd
          )
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const tasks = []
      let installed = false
      verifiedShells.clear()
      await Promise.all([
        rm(reportsPath, { force: true }),
        rm(startedPath, { force: true }),
        rm(releasePath, { force: true }),
        rm(archiveDir, { force: true, recursive: true }),
      ])
      // A system temporary directory guarantees the plain workspace has no parent Git repository.
      fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'wework-turn-diff-')))
      gitWorkspace = join(fixtureRoot, 'git')
      plainWorkspace = join(fixtureRoot, 'plain')
      writerPath = join(resultDir, 'turn-diff-write.mjs')
      const reporterPath = join(resultDir, 'turn-diff-report.mjs')
      await Promise.all([
        mkdir(gitWorkspace),
        mkdir(plainWorkspace),
        writeFile(writerPath, WRITER),
        writeFile(reporterPath, REPORTER),
      ])
      const git = args => execFileSync('git', ['-C', gitWorkspace, ...args], { stdio: 'pipe' })
      git(['init', '-q'])
      git(['config', 'user.name', 'Wework E2E'])
      git(['config', 'user.email', 'wework-e2e@example.test'])
      git(['config', 'commit.gpgsign', 'false'])
      git(['config', 'core.hooksPath', join(fixtureRoot, 'unused-git-hooks')])
      await writeFile(join(gitWorkspace, 'source.txt'), 'base\n')
      await writeFile(join(gitWorkspace, 'dirty.txt'), 'committed\n')
      git(['add', '--all'])
      git(['commit', '-qm', 'fixture'])
      await writeFile(join(gitWorkspace, 'dirty.txt'), 'user dirty before turn\n')
      await writeFile(join(gitWorkspace, 'user-untracked.txt'), 'user file before turn\n')
      assert.throws(() =>
        execFileSync('git', ['-C', plainWorkspace, 'rev-parse', '--show-toplevel'], {
          stdio: 'pipe',
        })
      )
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
      assert.ok(model, 'Turn hooks require the configured real Codex model route')
      const executionRequest = (taskId, phase, newSession) => ({
        task_id: taskId,
        subtask_id: `${taskId}-${phase}`,
        user_id: 9001,
        prompt: promptFor(phase),
        new_session: newSession,
        bot: [{ shell_type: 'Codex', name: 'Turn diff verification' }],
        model_config: {
          model_id: model.local_model_id,
          model_provider: model.provider,
          runtime_config: { codex: { use_user_config: true, configured: true } },
        },
      })
      const waitDone = (taskId, phase) =>
        waitForValue(
          async () => (await rpc('runtime.tasks.get', { taskId })).task,
          task => verifiedShells.has(phase) && task?.running === false && task.status === 'done',
          `Turn diff task ${taskId} did not complete`,
          modelResponseTimeoutMs
        )
      try {
        await rpc('runtime.hooks.create', {
          manifest: {
            schemaVersion: 1,
            id: PLUGIN_ID,
            name: 'Turn diff E2E',
            description: '',
            version: '1.0.0',
          },
          hooks: {
            TurnCompleted: [
              {
                matcher: '.*',
                hooks: [
                  {
                    type: 'command',
                    command: commandLine([
                      process.execPath,
                      reporterPath,
                      reportsPath,
                      archiveDir,
                      releasePath,
                      startedPath,
                    ]),
                    timeout: 60,
                    async: false,
                  },
                ],
              },
            ],
          },
        })
        installed = true
        active = true
        const taskId = 'turn-diff-git-e2e'
        tasks.push(taskId)
        const created = await rpc('runtime.tasks.create', {
          taskId,
          title: 'Turn Git diff',
          runtime: 'codex',
          workspacePath: gitWorkspace,
          message: promptFor('first'),
          executionRequest: executionRequest(taskId, 'first', true),
        })
        assert.equal(created.accepted, true)
        const firstTask = await waitDone(taskId, 'first')
        await waitForValue(
          () => reportsAt(startedPath),
          values => values.length === 1,
          'The first background hook did not start',
          uiTimeoutMs
        )
        assert.deepEqual(await reportsAt(reportsPath), [], 'The held hook finished before release')
        const sent = await rpc('runtime.tasks.send', {
          taskId,
          message: promptFor('second'),
          executionRequest: executionRequest(taskId, 'second', false),
        })
        assert.equal(sent.accepted, true)
        await waitDone(taskId, 'second')
        assert.ok(verifiedShells.has('second'), 'The follow-up turn did not execute its shell')
        assert.deepEqual(
          await reportsAt(reportsPath),
          [],
          'Hook delivery unexpectedly bypassed its gate'
        )
        await writeFile(releasePath, 'release')
        let reports = await waitForValue(
          () => reportsAt(reportsPath),
          values => values.length === 2,
          'The background hooks did not archive both complete turn increments',
          modelResponseTimeoutMs
        )
        const first = reports[0]
        assert.equal(first.hook_event_name, 'TurnCompleted')
        assert.equal(first.session_id, firstTask.threadId)
        assert.equal(first.cwd, gitWorkspace)
        assert.equal(first.status, 'completed')
        assert.deepEqual(first.files.sort(), ['first-only.txt', 'large.txt', 'source.txt'])
        assert.equal(first.patch_checks.firstIncrement, true)
        assert.equal(first.patch_checks.dirtyBaseline, false)
        assert.equal(
          first.patch_checks.secondFile,
          false,
          'The next turn contaminated the first artifact'
        )
        assert.ok(
          first.diff_artifact.size_bytes > LARGE_FILE_BYTES,
          'The complete patch must exceed the former 8 MiB capture limit'
        )
        assert.equal(first.large_added_lines, LARGE_FILE_BYTES / LARGE_LINE_BYTES)
        assert.equal(first.patch_checks.largeStart, true)
        assert.equal(first.patch_checks.largeEnd, true)
        const second = reports[1]
        assert.equal(second.session_id, first.session_id)
        assert.notEqual(second.turn_id, first.turn_id)
        assert.notEqual(second.event_id, first.event_id)
        assert.ok(second.sequence > first.sequence, 'Background delivery lost turn ordering')
        assert.deepEqual(second.files.sort(), ['second-only.txt', 'source.txt'])
        assert.equal(second.patch_checks.secondIncrement, true)
        assert.equal(second.patch_checks.firstFile, false)
        assert.equal(second.large_added_lines, 0)
        const plainTask = 'turn-diff-plain-e2e'
        tasks.push(plainTask)
        assert.equal(
          (
            await rpc('runtime.tasks.create', {
              taskId: plainTask,
              title: 'Non Git turn',
              runtime: 'codex',
              workspacePath: plainWorkspace,
              message: promptFor('plain'),
              executionRequest: executionRequest(plainTask, 'plain', true),
            })
          ).accepted,
          true
        )
        await waitDone(plainTask, 'plain')
        // Negative observation window: a completed non-Git turn must never schedule a hook.
        await delay(NEGATIVE_OBSERVATION_MS)
        reports = await reportsAt(reportsPath)
        assert.equal(reports.length, 2, 'A non-Git turn or duplicate completion dispatched a hook')
        assert.deepEqual([...verifiedShells].sort(), PHASES.toSorted())
        assert.equal(await readFile(join(plainWorkspace, 'source.txt'), 'utf8'), 'plain\n')
        return {
          gitTurns: 2,
          nonGitTurns: 1,
          shellWritesVerified: true,
          largeFileBytes: LARGE_FILE_BYTES,
          reportsPath,
        }
      } finally {
        active = false
        await writeFile(releasePath, 'release')
        try {
          for (const taskId of tasks) await rpc('runtime.tasks.cancel', { taskId })
        } finally {
          try {
            if (installed) await rpc('runtime.hooks.delete', { pluginId: PLUGIN_ID })
          } finally {
            await rm(fixtureRoot, { recursive: true, force: true })
          }
        }
      }
    },
  }
}
