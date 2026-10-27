import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'

const PROCESS_START = /codex shared app-server process starting process_id=(\d+)/g
const REVISION_KEY = 'WEGENT_CAPABILITY_REVISION'

async function listSkills(control, workspacePath, timeoutMs) {
  const response = await requestExecutor(
    control,
    'runtime.codex.app_server.request',
    { method: 'skills/list', params: { cwds: [workspacePath], forceReload: true } },
    timeoutMs
  )
  assert.ok(Array.isArray(response.data), 'Native skills/list did not return its data array')
  return response.data.flatMap(entry => {
    assert.ok(Array.isArray(entry.skills), 'Native skills/list entry omitted its skills array')
    return entry.skills
  })
}

function processStarts(log, fromOffset = 0) {
  return [...log.slice(fromOffset).matchAll(PROCESS_START)].map(match => ({
    processId: Number(match[1]),
    offset: fromOffset + match.index,
  }))
}

async function waitForLog(logPath, timeoutMs, description, inspect) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const log = await readFile(logPath, 'utf8')
    const result = inspect(log)
    if (result) return { ...result, logLength: log.length }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out waiting for ${description}`)
}

export async function restartTemporaryChatCapabilities(
  control,
  { executorHome, resultDir, workspacePath, uiTimeoutMs }
) {
  const skillName = `wegent-connector-recovery-${randomUUID().slice(0, 8)}`
  const skillDir = join(executorHome, 'codex', 'skills', skillName)
  const skillPath = join(skillDir, 'SKILL.md')
  const logPath = join(resultDir, 'executor.log')
  const evidence = { skillName, skillPath, startedAt: new Date().toISOString() }
  try {
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, '.wegent-connector'), 'managed\n', { flag: 'wx' })
    await writeFile(
      skillPath,
      `---\nname: ${skillName}\ndescription: Verify temporary chat recovery after a managed capability change.\n---\n\n# Temporary chat capability recovery\n\nThis isolated test skill is removed through the real connector clear operation.\n`,
      { flag: 'wx' }
    )
    const skillsBefore = await listSkills(control, workspacePath, uiTimeoutMs)
    const consumed = skillsBefore.filter(skill => skill.name === skillName)
    assert.equal(consumed.length, 1, 'The real Codex process did not load the seeded skill')
    assert.equal(await realpath(consumed[0].path), await realpath(skillPath))
    evidence.loadedBeforeClear = true

    const before = await waitForLog(
      logPath,
      uiTimeoutMs,
      'the existing native process PID',
      log => {
        const latest = processStarts(log).at(-1)
        return latest ? { processId: latest.processId } : null
      }
    )
    evidence.beforeLogOffset = before.logLength
    evidence.beforeProcessId = before.processId
    // Share the renderer's revision allocator with connector configure and sync.
    const cleared = JSON.parse(
      await control.command('clearLocalExecutorConnectors', 'body', {
        timeoutMs: uiTimeoutMs,
      })
    )
    evidence.clearResult = cleared
    assert.equal(cleared.configured, false, 'The real connector clear did not complete')
    assert.notEqual(cleared.stale, true, 'The connector clear revision was rejected as stale')
    assert.equal(cleared.changed, true, 'Deleting the loaded connector skill was not reported')
    await assert.rejects(lstat(skillDir), { code: 'ENOENT' })
    evidence.removedByClear = true

    const skillsAfter = await listSkills(control, workspacePath, uiTimeoutMs)
    assert.equal(
      skillsAfter.some(skill => skill.name === skillName),
      false,
      'The native process still exposes the deleted connector skill'
    )
    evidence.absentAfterClear = true

    const after = await waitForLog(
      logPath,
      uiTimeoutMs,
      'a capability revision restart with a different native PID (all model turns must be idle)',
      log => {
        const recent = log.slice(before.logLength)
        const restarts = recent.matchAll(
          /[^\n]*codex shared app-server environment restart scheduled[^\n]*/g
        )
        for (const restart of restarts) {
          const changedKeys = / changed_env_keys=([^\s]*)/.exec(restart[0])?.[1].split(',')
          if (!changedKeys?.includes(REVISION_KEY)) continue
          const restartOffset = before.logLength + restart.index
          const process = processStarts(log, restartOffset).find(
            started => started.processId !== before.processId
          )
          if (!process) continue
          assert.match(restart[0], / active_thread_count=0(?:\s|$)/)
          assert.match(restart[0], / active_turn_count=0(?:\s|$)/)
          return {
            restartLogOffset: restartOffset,
            restartLogLine: restart[0],
            processStartLogOffset: process.offset,
            processId: process.processId,
          }
        }
        return null
      }
    )
    evidence.afterLogOffset = after.logLength
    evidence.restartLogOffset = after.restartLogOffset
    evidence.restartLogLine = after.restartLogLine
    evidence.processStartLogOffset = after.processStartLogOffset
    evidence.afterProcessId = after.processId
    evidence.completedAt = new Date().toISOString()
    return {
      beforeLogOffset: evidence.beforeLogOffset,
      afterLogOffset: evidence.afterLogOffset,
      restartLogOffset: evidence.restartLogOffset,
      beforeProcessId: evidence.beforeProcessId,
      afterProcessId: evidence.afterProcessId,
      skillName,
      skillPath,
    }
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await writeFile(
      join(resultDir, 'temporary-chat-capability-restart.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8'
    )
  }
}
