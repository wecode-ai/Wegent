import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  handleModelMaintenanceRequest,
  readRawRequestBody,
} from '../e2e/desktop/modules/response-protocol.mjs'
import { shellCommandResponse } from '../e2e/desktop/modules/shell-command-response.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR as pane,
  COMPOSER_SELECTOR as composer,
  assistantMessage,
  reasoningEvents,
  responseCompleted,
  responseCreated,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForBottom,
} from '../e2e/desktop/modules/streaming-text-fixture.mjs'
import { waitForWorkbenchDebugState } from '../e2e/desktop/modules/workspace-flows.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import { waitForValue } from '../e2e/desktop/modules/workspace-agent-setup.mjs'
import { waitForClosedStartupSplash } from '../e2e/desktop/modules/native-window-state.mjs'
import {
  createDevtoolsClient,
  startPerformanceRecording,
  stopPerformanceRecording,
  writeDiagnosticFile,
} from './ai-verify-devtools.mjs'

const run = promisify(execFile)
const prompt = 'WEWORK_CPU_BENCHMARK_SINGLE_TASK'
const prefix = 'RENDERER_CPU_BENCHMARK_STREAM_STARTED'
const suffix = 'RENDERER_CPU_BENCHMARK_STREAM_FINISHED'
const idleSamples = 7
const sampleIntervalMs = 1000
const streamPieces = 120
const streamIntervalMs = 100
const historyPrompt = 'WEWORK_RENDERER_BENCHMARK_HISTORY_'
const historyTaskCount = 16
const concurrentTaskCount = 10
const concurrentPrompt = 'WEWORK_CPU_BENCHMARK_CONCURRENT_'
const concurrentStreamPieces = 390
const projectIssueCount = 480
// The sampled App had 267 unarchived local task records, including running work.
const persistedTaskCount = 257
// Use a populated tool history within the range observed near the recorded window.
const foregroundToolCalls = 180
const foregroundToolBatch = 24
const foregroundCpuSamplePieces = [25, 50, 75, 100, 125, 150, 175, 200]
const pendingGoalUpdatePieces = [255, 295, 335]
const pendingScrollPieces = [245, 265, 285, 305, 325, 345]
const measuredToolPieces = [35, 70, 105, 140, 175]
const measuredToolTasks = new Set(['01', '02', '03', '04'])
const measuredToolBatch = 2
const concurrentClockTask = '05'
const measuredReasoningTasks = new Set(['01', '02', '03'])
const measuredReasoningPieces = 25
const limits = {
  idleCpuPercent: 3,
  singleTaskCpuPercent: 15,
  tenTaskCpuPercent: 20,
  maxTurnUpdateLongTaskMs: 100,
  peakObservedJsHeapBytes: 200_000_000,
}

export function installTurnUpdateProbe() {
  const listeners = (window.__WEWORK_E2E_RUNTIME_EVENT_LISTENERS__ ??= new Set())
  const updates = []
  // Observe the whole browser task, including React work in its microtasks.
  const longTasks = []
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()))
  observer.observe({ type: 'longtask' })
  const longFrames = []
  const frameObserver = PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
    ? new PerformanceObserver(list => longFrames.push(...list.getEntries()))
    : null
  frameObserver?.observe({ type: 'long-animation-frame' })
  const settled = new Set()
  let onSettled
  const listener = ({ event, payload }) => {
    const status = payload.data?.status
    if (event !== 'runtime.turn.updated' || !payload.data?.task) return
    if (status !== 'started' && status !== 'settled') return
    updates.push({ taskId: payload.taskId, status, observedAt: performance.now() })
    performance.mark?.(`wework-profile:turn-${status}`)
    if (status === 'settled') {
      settled.add(payload.taskId)
      onSettled?.(payload.taskId)
    }
  }
  listeners.add(listener)
  window.__weworkProfileTurnUpdates = {
    waitForSettled(taskId, timeoutMs) {
      if (settled.has(taskId)) return true
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          onSettled = undefined
          resolve(false)
        }, timeoutMs)
        onSettled = settledTaskId => {
          if (settledTaskId !== taskId) return
          clearTimeout(timer)
          onSettled = undefined
          resolve(true)
        }
      })
    },
    stop(taskId) {
      listeners.delete(listener)
      longTasks.push(...observer.takeRecords())
      observer.disconnect()
      if (frameObserver) {
        longFrames.push(...frameObserver.takeRecords())
        frameObserver.disconnect()
      }
      delete window.__weworkProfileTurnUpdates
      let index = 0
      return updates
        .filter(update => update.taskId === taskId)
        .map(({ status, observedAt }) => {
          while (
            longTasks[index] &&
            longTasks[index].startTime + longTasks[index].duration <= observedAt
          ) {
            index++
          }
          const task = longTasks[index]
          const frame = longFrames.find(
            entry => entry.startTime <= observedAt && observedAt < entry.startTime + entry.duration
          )
          return {
            status,
            observedAt,
            longTaskMs: task && task.startTime <= observedAt ? task.duration : 0,
            ...(frame && {
              frame: {
                durationMs: frame.duration,
                scripts: frame.scripts
                  .map(script => ({
                    source: script.sourceURL,
                    functionName: script.sourceFunctionName,
                    position: script.sourceCharPosition,
                    durationMs: script.duration,
                    forcedLayoutMs: script.forcedStyleAndLayoutDuration,
                  }))
                  .sort((left, right) => right.durationMs - left.durationMs)
                  .slice(0, 5),
              },
            }),
          }
        })
    },
  }
}

async function rendererPids(control) {
  const { processes } = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  const pids = processes
    .filter(process => process.source === 'electron' && process.kind === 'window')
    .map(process => process.pid)
  assert.ok(pids.length > 0, 'No isolated renderer process was found')
  return pids
}

async function cpuSnapshot(pids) {
  const { stdout } = await run('ps', ['-p', pids.join(','), '-o', 'time='])
  const counters = stdout.trim().split(/\s+/)
  assert.equal(counters.length, pids.length, 'A measured renderer exited')
  assert.ok(
    counters.every(value => /^\d+(?::\d+)+\.\d+$/.test(value)),
    'Invalid macOS CPU counters'
  )
  const seconds = counters.reduce(
    (total, value) => total + value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0),
    0
  )
  return { seconds, time: performance.now() }
}

function cpuPercent(before, after) {
  return ((after.seconds - before.seconds) * 100_000) / (after.time - before.time)
}

export function peakTenSecondCpu(samples) {
  let peak
  let end = 1
  for (const start of samples) {
    while (end < samples.length && samples[end].time - start.time < 10_000) end++
    if (end === samples.length) break
    peak = Math.max(peak ?? 0, cpuPercent(start, samples[end]))
  }
  assert.notEqual(peak, undefined, 'Concurrent phase did not yield a ten-second CPU window')
  return peak
}

async function observeText(client, target, text, timeoutMs) {
  const result = await client({
    action: 'command',
    target,
    method: 'Runtime.evaluate',
    params: {
      expression: `(${function waitForText(selector, expected, timeout) {
        return new Promise(resolve => {
          const check = () => {
            const messages = document.querySelectorAll(selector)
            if ([...messages].some(message => message.textContent?.includes(expected))) finish(true)
          }
          const finish = matched => {
            observer.disconnect()
            clearTimeout(timer)
            resolve(matched)
          }
          const observer = new MutationObserver(check)
          observer.observe(document.body, { childList: true, characterData: true, subtree: true })
          const timer = setTimeout(() => finish(false), timeout)
          check()
        })
      }})(${JSON.stringify(pane + ' [data-testid="message-assistant"]')}, ${JSON.stringify(text)}, ${timeoutMs})`,
      awaitPromise: true,
      returnByValue: true,
    },
  })
  assert.equal(result.result?.value, true, `Timed out waiting for the assistant text ${text}`)
}

async function emitStream(response, id, pieces = streamPieces, onPiece) {
  const { itemId, start } = streamingEvents(id)
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  let text = prefix
  response.write(sse([...start, ...textDeltaEvents(itemId, text)]))
  for (let i = 0; i < pieces; i++) {
    await delay(streamIntervalMs)
    const delta =
      i === pieces - 1
        ? '\n\n' + suffix
        : i % 5 === 0
          ? '\n\n- Streaming item ' + i
          : ' streamed words'
    response.write(sse(textDeltaEvents(itemId, delta, text.length)))
    text += delta
    onPiece?.(i)
  }
  response.end(sse(streamingEvents(id, text).finish))
}

async function emitReasoning(response, id, pieces, onPiece) {
  const delta = ' Verify the workspace state and compare the previous command output.'
  const [item, part, ...events] = reasoningEvents(
    `${id}-reasoning`,
    delta.repeat(pieces),
    delta.length
  )
  const completed = events.pop()
  const summary = events.pop()
  response.write(sse([item, part]))
  for (const [index, event] of events.entries()) {
    await delay(streamIntervalMs)
    if (response.destroyed) return
    response.write(sse([event]))
    onPiece?.(index)
  }
  response.write(sse([summary, completed]))
  return completed.item
}

function profileCommand(index) {
  const first = (index % 25) + 1
  return [
    `printf "%s\\n" "Inspect workspace files for conversation step ${index + 1}"`,
    'git status --short -- README.md "README file.md" auth.ts',
    `sed -n '${first},${first + 8}p' README.md`,
    `sed -n '${first},${first + 12}p' "README file.md"`,
    'rg -n -i --max-count 5 "workspace|profile|fixture|task|runtime|conversation|configuration" README.md "README file.md" auth.ts || true',
    'git diff --stat -- README.md "README file.md" auth.ts',
    'git log -1 --format="%h %s" -- README.md "README file.md" auth.ts',
    'wc -l README.md "README file.md" auth.ts',
  ].join('\n')
}

async function measureConcurrentTasks({
  control,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  observeForegroundText,
  mark,
  windowState,
  pids,
  concurrentResponses,
  getForegroundToolsSent,
  startConcurrent,
  finishConcurrent,
  streamMilestones,
}) {
  const origin = await control.command('getLocationOrigin', 'body')
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs, { origin })
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(entry => entry.runtime === 'codex' && entry.is_default)
  assert.ok(model, 'The concurrent profile requires the isolated Codex model')
  const { projectId, issues, pendingIssueSelector } = await preparePendingIssues(
    control,
    rpc,
    uiTimeoutMs
  )
  await rpc('runtime.settings.update', { maxConcurrentTasks: concurrentTaskCount })
  const taskIds = []
  let deviceId
  for (let i = 1; i <= concurrentTaskCount; i++) {
    const index = String(i).padStart(2, '0')
    const prompt = concurrentPrompt + index
    const taskId = 'renderer-profile-' + index
    taskIds.push(taskId)
    finishConcurrent.set(index, Promise.withResolvers())
    const result = await rpc('runtime.tasks.create', {
      taskId,
      title: prompt,
      workspacePath,
      runtime: 'codex',
      message: prompt,
      executionRequest: {
        task_id: taskId,
        subtask_id: taskId + '-first-turn',
        user_id: 9001,
        prompt,
        new_session: true,
        origin: {
          type: 'board_task',
          projectStore: 'local',
          cloudProjectId: projectId,
          loopItemId: issues[i - 1],
        },
        bot: [{ shell_type: 'Codex', name: 'Renderer profile' }],
        model_config: {
          model_id: model.local_model_id,
          model_provider: model.provider,
          runtime_config: { codex: { use_user_config: true, configured: true } },
        },
      },
    })
    assert.equal(result.accepted, true, `The executor did not admit ${taskId}`)
    deviceId ??= result.deviceId
  }
  for (let offset = 0; offset < foregroundToolCalls; offset += foregroundToolBatch) {
    const sent = Math.min(offset + foregroundToolBatch, foregroundToolCalls)
    await waitForValue(
      getForegroundToolsSent,
      count => count >= sent,
      `Foreground task did not emit history batch ending at tool call ${sent}`,
      uiTimeoutMs
    )
  }
  await waitForValue(
    async () => [...concurrentResponses.keys()],
    indices => indices.length === concurrentTaskCount,
    'All ten tasks must reach the model server before the measurement',
    modelResponseTimeoutMs
  )
  const capacity = (await rpc('runtime.capacity.get', {})).categories.personal
  assert.ok(taskIds.every(taskId => capacity.active_task_ids.includes(taskId)))
  const taskId = taskIds[0]
  assert.ok(deviceId, 'The executor did not return a device for the concurrent tasks')
  await control.command('navigate', 'body', {
    value: '/runtime-tasks?' + new URLSearchParams({ deviceId, taskId }),
  })
  await waitForWorkbenchDebugState(
    control,
    state => state.taskId === taskId && state.isBusy,
    'The foreground conversation did not show the running profile task',
    uiTimeoutMs,
    'pane-activity'
  )
  assert.ok([...concurrentResponses.values()].every(response => !response.destroyed))
  const foregroundBefore = await windowState()
  await mark('concurrent-conversation-start')
  const foregroundSamples = [await cpuSnapshot(pids)]
  startConcurrent.resolve()
  try {
    const goal = await rpc('runtime.tasks.goal.set', {
      taskId,
      objective: 'Measure Goal updates while multiple tasks are streaming',
      status: 'active',
    })
    assert.equal(goal.goal?.status, 'active', goal.error)
    await waitForWorkbenchDebugState(
      control,
      state => state.pane?.goal?.status === 'active',
      'The foreground conversation did not receive the native Goal update',
      uiTimeoutMs
    )
  } finally {
    const cleared = await rpc('runtime.tasks.goal.clear', { taskId })
    assert.equal(cleared.success, true, cleared.error)
  }
  for (const piece of foregroundCpuSamplePieces) {
    assert.ok(await streamMilestones.get(piece).promise, `Foreground stream missed piece ${piece}`)
    foregroundSamples.push(await cpuSnapshot(pids))
  }
  await observeForegroundText('Streaming item 45')
  const foregroundEnd = await cpuSnapshot(pids)
  foregroundSamples.push(foregroundEnd)
  const foregroundAfter = await windowState()
  await mark('concurrent-conversation-end')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="workspace-tab-select-pending-interactions"]'
  )
  await control.command('waitFor', pendingIssueSelector, { timeoutMs: uiTimeoutMs })
  assert.ok(
    [...concurrentResponses.values()].every(response => !response.writableEnded),
    'All ten streams must still be running when the pending Issues measurement starts'
  )
  await mark('concurrent-pending-start')
  const pendingSamples = [await cpuSnapshot(pids)]
  const pendingActions = [...pendingGoalUpdatePieces, ...pendingScrollPieces].sort((a, b) => a - b)
  for (const piece of pendingActions) {
    assert.ok(await streamMilestones.get(piece).promise, `Concurrent stream missed piece ${piece}`)
    const scrollIndex = pendingScrollPieces.indexOf(piece)
    if (scrollIndex !== -1) {
      await control.command(
        'scrollToRatioAsUser',
        '[data-testid="runtime-interactions-page"] .interaction-queue .overflow-y-auto',
        { value: scrollIndex % 2 === 0 ? '0.8' : '0.2', timeoutMs: uiTimeoutMs }
      )
      pendingSamples.push(await cpuSnapshot(pids))
      continue
    }
    const index = pendingGoalUpdatePieces.indexOf(piece)
    const taskId = taskIds[index + 1]
    const goal = await rpc('runtime.tasks.goal.set', {
      taskId,
      objective: 'Measure background task status changes in Pending Issues',
      status: 'active',
    })
    assert.equal(goal.goal?.status, 'active', goal.error)
    const cleared = await rpc('runtime.tasks.goal.clear', { taskId })
    assert.equal(cleared.success, true, cleared.error)
  }
  await Promise.all([...finishConcurrent.values()].map(entry => entry.promise))
  await waitForValue(
    async () => (await rpc('runtime.capacity.get', {})).categories.personal.active_task_ids,
    activeTaskIds => taskIds.every(id => !activeTaskIds.includes(id)),
    'All ten measured tasks must release their executor slots',
    uiTimeoutMs
  )
  const pendingEnd = await cpuSnapshot(pids)
  pendingSamples.push(pendingEnd)
  await mark('concurrent-pending-end')
  return {
    concurrentCpuPercent: {
      foregroundConversation: cpuPercent(foregroundSamples[0], foregroundEnd),
      foregroundPeakTenSecondCpu: peakTenSecondCpu(foregroundSamples),
      pendingIssues: cpuPercent(pendingSamples[0], pendingEnd),
      pendingPeakTenSecondCpu: peakTenSecondCpu(pendingSamples),
    },
    foregroundWindow: { before: foregroundBefore, after: foregroundAfter },
  }
}

async function preparePendingIssues(control, rpc, timeoutMs) {
  const profileResponse = await fetch(new URL('/api/users/me', control.url))
  assert.ok(profileResponse.ok)
  const { id: userId } = await profileResponse.json()
  assert.ok(Number.isInteger(userId) && userId > 0)
  const project = await rpc('projects.create', { name: 'Renderer profile project' })
  const issues = []
  for (let offset = 0; offset < projectIssueCount; offset += 8) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, projectIssueCount - offset) }, async (_, index) => {
        const position = offset + index
        const open = position < concurrentTaskCount || position >= projectIssueCount - 10
        const issue = await rpc('todos.create', {
          project_id: project.id,
          todo: {
            title: `Renderer profile issue ${position + 1}`,
            assignee_user_id: userId,
            status: open ? 'inbox' : 'completed',
          },
        })
        assert.equal(issue.status, open ? 'inbox' : 'completed')
        return issue.id
      })
    )
    issues.push(...batch)
  }
  await control.command(
    'clickWhenEnabled',
    '[data-testid="workspace-tab-select-pending-interactions"]'
  )
  const page = '[data-testid="runtime-interactions-page"]'
  await control.command('clickWhenEnabled', `${page} [data-testid="interactions-refresh"]`)
  const issueSelector = issueId => {
    const id = `project-issue:local:${project.id}:${issueId}`
    return `${page} [data-testid="interaction-list-item"][data-interaction-id=${JSON.stringify(id)}]`
  }
  const pendingIssueSelector = issueSelector(issues.at(-1))
  await control.command('waitFor', pendingIssueSelector, { timeoutMs })
  await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
  return { projectId: project.id, issues, pendingIssueSelector }
}

export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
  workspacePath,
  executorHome,
}) {
  const capture = process.env.WEWORK_RENDERER_PROFILE_CAPTURE === 'true'
  const measureProcesses = process.env.WEWORK_RENDERER_PROFILE_PROCESSES === 'true'
  const measureHistory = process.env.WEWORK_RENDERER_PROFILE_HISTORY === 'true'
  const samples = []
  const processSamples = []
  let historyIndex = 0
  let ready = false
  let started = false
  let finished = false
  let start
  let pids
  const concurrentResponses = new Map()
  const startConcurrent = Promise.withResolvers()
  const finishConcurrent = new Map()
  const streaming = new Set()
  const streamMilestones = new Map(
    [
      ...new Set([
        ...foregroundCpuSamplePieces,
        ...pendingGoalUpdatePieces,
        ...pendingScrollPieces,
        ...measuredToolPieces,
      ]),
    ].map(piece => [piece, Promise.withResolvers()])
  )
  let foregroundToolsSent = 0
  let reasoningDeltasSent = 0
  const countReasoningDelta = () => reasoningDeltasSent++
  const measuredBatches = new Map()
  return {
    async prepareApp() {
      const runtimeWork = join(executorHome, 'runtime-work')
      await mkdir(runtimeWork, { recursive: true })
      const tasks = Object.fromEntries(
        Array.from({ length: persistedTaskCount }, (_, index) => {
          const id = `renderer-profile-saved-${index}`
          return [
            id,
            {
              local_task_id: id,
              title: `Saved workbench task ${index + 1}`,
              workspace_path: workspacePath,
              runtime: 'codex',
              archived: false,
            },
          ]
        })
      )
      await writeFile(join(runtimeWork, 'index.json'), JSON.stringify({ version: 1, tasks }), {
        flag: 'wx',
        mode: 0o600,
      })
    },
    cleanup() {
      startConcurrent.resolve()
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      if (!ready && !historyIndex) return false
      const body = await readRawRequestBody(request)
      const modelRequest = JSON.parse(body)
      if (handleModelMaintenanceRequest(modelRequest, response)) return true
      const index =
        body.match(new RegExp(`${concurrentPrompt}(\\d{2})`))?.[1] ??
        body.match(/renderer-profile-command-(\d{2})-/)?.[1]
      if (index && finishConcurrent.has(index) && !streaming.has(index)) {
        const batches = measuredBatches.get(index) ?? 0
        const foregroundTools = index === '01' && foregroundToolsSent < foregroundToolCalls
        if (!foregroundTools) {
          concurrentResponses.set(index, response)
          await startConcurrent.promise
        }
        const measuredTools = measuredToolTasks.has(index) && batches < measuredToolPieces.length
        if (
          !foregroundTools &&
          measuredTools &&
          (!(await streamMilestones.get(measuredToolPieces[batches]).promise) || response.destroyed)
        )
          return true
        if (foregroundTools || measuredTools) {
          const offset = foregroundTools
            ? foregroundToolsSent
            : foregroundToolCalls + batches * measuredToolBatch
          const count = foregroundTools
            ? Math.min(foregroundToolBatch, foregroundToolCalls - offset)
            : measuredToolBatch
          if (foregroundTools) foregroundToolsSent += count
          else measuredBatches.set(index, batches + 1)
          const id = `wework-benchmark-tool-history-${index}-${offset}`
          const hasReasoning = !foregroundTools && measuredReasoningTasks.has(index)
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.write(sse([responseCreated(id)]))
          const reasoning = hasReasoning
            ? await emitReasoning(response, id, measuredReasoningPieces, countReasoningDelta)
            : undefined
          if (response.destroyed) return true
          const events = Array.from({ length: count }, (_, toolIndex) =>
            shellCommandResponse(
              modelRequest,
              `renderer-profile-command-${index}-${offset + toolIndex}`,
              profileCommand(offset + toolIndex),
              workspacePath
            )
          ).flatMap((events, index) =>
            events.map(event => ({ ...event, output_index: index + Number(hasReasoning) }))
          )
          const output = events.filter(event => event.type === 'response.output_item.done')
          response.end(
            sse([
              ...events,
              responseCompleted(id, [
                ...(reasoning ? [reasoning] : []),
                ...output.map(event => event.item),
              ]),
            ])
          )
          return true
        }
        streaming.add(index)
        try {
          if (!response.destroyed && index === concurrentClockTask) {
            const id = `wework-benchmark-${index}`
            response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
            response.write(sse([responseCreated(id)]))
            const reasoning = await emitReasoning(response, id, concurrentStreamPieces, piece => {
              countReasoningDelta()
              streamMilestones.get(piece)?.resolve(true)
            })
            if (!response.destroyed) {
              const reply = { ...assistantMessage(suffix, 'final_answer'), output_index: 1 }
              response.end(sse([reply, responseCompleted(id, [reasoning, reply.item])]))
            }
          } else if (!response.destroyed)
            await emitStream(
              response,
              `wework-benchmark-${index}`,
              batches ? concurrentStreamPieces - measuredToolPieces.at(-1) : concurrentStreamPieces
            )
        } finally {
          if (index === concurrentClockTask) {
            for (const milestone of streamMilestones.values()) milestone.resolve(false)
          }
          finishConcurrent.get(index).resolve()
        }
        return true
      }
      if (!ready && body.includes(historyPrompt + historyIndex)) {
        const id = 'wework-profile-history-' + historyIndex
        const content = Array.from(
          { length: 72 },
          (_, index) =>
            `### Record ${index + 1}\n\nSaved result for task ${historyIndex}. This paragraph represents a persisted assistant turn.\n`
        ).join('\n')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(id),
            assistantMessage(`${content}\n${id}`, 'final_answer'),
            responseCompleted(id),
          ])
        )
        return true
      }
      if (!ready || !body.includes(prompt)) return false
      if (started) return false
      started = true
      start = await cpuSnapshot(pids)
      await emitStream(response, 'wework-benchmark-response')
      finished = true
      return true
    },
    async verify(control) {
      const sidebar = '[data-testid="desktop-sidebar"]'
      await control.command('waitFor', sidebar, { timeoutMs: uiTimeoutMs })
      if ((await control.command('getAttribute', sidebar, { value: 'aria-hidden' })) === 'true') {
        await control.command('clickWhenEnabled', '[data-testid="expand-sidebar-button"]', {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]', {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('ensureLocalModelCatalogReady', 'body', { timeoutMs: uiTimeoutMs })
      const provider = await control.command(
        'getAttribute',
        pane + ' [data-testid="model-selector-button"]',
        {
          value: 'data-model-provider-id',
        }
      )
      assert.equal(provider, 'wework-e2e', 'The selected model must use the isolated model service')
      await waitForClosedStartupSplash(control, uiTimeoutMs)
      pids = await rendererPids(control)
      const inventory = await requestExecutor(control, 'runtime.tasks.list', {}, uiTimeoutMs)
      const savedTaskCount = inventory.workspaces
        .flatMap(workspace => workspace.tasks)
        .filter(task => task.taskId.startsWith('renderer-profile-saved-')).length
      assert.equal(savedTaskCount, persistedTaskCount, 'The profile must load the saved tasks')
      const textTimeoutMs = uiTimeoutMs + concurrentStreamPieces * streamIntervalMs
      const client = await createDevtoolsClient(resultDir, textTimeoutMs + 5000)
      const targets = await client({ action: 'targets' })
      const target = targets.find(
        entry =>
          entry.type === 'window' &&
          !entry.url.startsWith('devtools:') &&
          !entry.url.includes('startup-splash')
      )?.id
      assert.ok(target, 'The isolated main renderer was not found')
      const evaluate = async expression => {
        const { result, exceptionDetails } = await client({
          action: 'command',
          target,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        })
        assert.ok(!exceptionDetails, result.description ?? 'Renderer evaluation failed')
        return result.value
      }
      const mark = phase =>
        capture && evaluate(`performance.mark(${JSON.stringify(`wework-profile:${phase}`)})`)
      const windowState = () =>
        evaluate(`(async () => ({
          activity: await window.weworkElectronLifecycle.getWorkbenchActivity(),
          visibility: document.visibilityState,
          focused: document.hasFocus(),
        }))()`)
      const sampleHeap = async phase => {
        const { usedSize } = await client({
          action: 'command',
          target,
          method: 'Runtime.getHeapUsage',
        })
        assert.ok(Number.isFinite(usedSize), 'The renderer did not report its used JS heap')
        samples.push({ phase, at: Date.now(), usedSize })
      }
      const reportPath = join(resultDir, 'renderer-performance.json')
      const sampleProcesses = async phase => {
        const snapshot = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
        processSamples.push({
          phase,
          at: snapshot.capturedAt,
          incomplete: Boolean(snapshot.collectingSystemProcesses),
          degradation: snapshot.degraded?.map(entry => entry.code) ?? [],
          processes: snapshot.processes.map(process => ({
            pid: process.pid,
            parentPid: process.parentPid,
            kind: process.kind,
            source: process.source,
            owner: process.owner?.key ?? null,
            cpuPercent: process.cpuPercent,
            memoryBytes: process.memoryBytes,
            idleWakeupsPerSecond: process.idleWakeupsPerSecond,
          })),
        })
      }
      let recording = false
      let probingTurnUpdates = false
      try {
        if (measureHistory) {
          const taskIds = new Set()
          while (taskIds.size < historyTaskCount) {
            historyIndex = taskIds.size + 1
            await control.command('fill', composer, { value: historyPrompt + historyIndex })
            await control.command('press', composer, { key: 'Enter' })
            await observeText(
              client,
              target,
              'wework-profile-history-' + historyIndex,
              textTimeoutMs
            )
            const snapshot = await waitForWorkbenchDebugState(
              control,
              ({ taskId, isBusy }) => taskId && !taskIds.has(taskId) && isBusy === false,
              `Historical task ${historyIndex} did not settle`,
              textTimeoutMs,
              'pane-activity'
            )
            taskIds.add(snapshot.taskId)
            await sampleHeap('history')
            await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]', {
              visible: true,
              timeoutMs: uiTimeoutMs,
            })
            await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
          }
        }
        const before = await windowState()
        assert.equal(before.activity, 'foreground', 'Measure the foreground presentation path')
        const running = await requestExecutor(
          control,
          'runtime.tasks.running_count',
          {},
          uiTimeoutMs
        )
        assert.equal(running.runningCount, 0, 'The idle profile requires zero running tasks')
        if (capture) {
          await startPerformanceRecording(client, resultDir, target, {
            samplingIntervalUs: 100,
          })
          recording = true
        }
        await mark('idle-start')
        const idleStart = await cpuSnapshot(pids)
        for (let i = 0; i < idleSamples; i++) {
          await sampleHeap('idle')
          await delay(sampleIntervalMs)
        }
        const idleEnd = await cpuSnapshot(pids)
        await mark('idle-end')
        if (measureProcesses) await sampleProcesses('idle')
        assert.ok(
          await evaluate("PerformanceObserver.supportedEntryTypes.includes('longtask')"),
          'The renderer does not support long-task timing'
        )
        await evaluate(`(${installTurnUpdateProbe.toString()})()`)
        probingTurnUpdates = true

        const controller = new AbortController()
        const collect = async () => {
          try {
            while (!controller.signal.aborted) {
              await delay(sampleIntervalMs, undefined, { signal: controller.signal })
              await sampleHeap('running')
              if (
                measureProcesses &&
                start &&
                performance.now() - start.time >= 6000 &&
                processSamples.length === 1
              )
                await sampleProcesses('running')
            }
          } catch (error) {
            if (error.name !== 'AbortError') throw error
          }
        }
        const interact = async () => {
          try {
            ready = true
            await control.command('fill', composer, { value: prompt })
            await control.command('press', composer, { key: 'Enter' })
            await observeText(client, target, prefix, uiTimeoutMs)
            assert.ok(!finished, 'The first response text must appear while streaming')
            await observeText(client, target, suffix, textTimeoutMs)
            return await cpuSnapshot(pids)
          } finally {
            controller.abort()
          }
        }
        const [interaction, sampling] = await Promise.allSettled([interact(), collect()])
        if (interaction.status === 'rejected') throw interaction.reason
        if (sampling.status === 'rejected') throw sampling.reason
        const end = interaction.value
        assert.ok(start, 'The isolated model stream did not start')
        await waitForBottom(control, 'The streamed conversation', uiTimeoutMs)
        const { taskId } = await waitForWorkbenchDebugState(
          control,
          ({ taskId, isBusy }) => taskId && isBusy === false,
          'The profiled turn did not settle in the workbench',
          uiTimeoutMs,
          'pane-activity'
        )
        assert.ok(
          await evaluate(
            `window.__weworkProfileTurnUpdates.waitForSettled(${JSON.stringify(taskId)}, ${uiTimeoutMs})`
          ),
          'The profiled task did not receive a settled runtime.turn.updated snapshot'
        )
        const turnUpdates = await evaluate(
          `window.__weworkProfileTurnUpdates.stop(${JSON.stringify(taskId)})`
        )
        probingTurnUpdates = false
        assert.ok(
          turnUpdates.some(update => update.status === 'started'),
          'The profiled task did not receive a started runtime.turn.updated snapshot'
        )
        await sampleHeap('settled')
        if (measureProcesses) await sampleProcesses('settled')
        const { concurrentCpuPercent, foregroundWindow } = await measureConcurrentTasks({
          control,
          workspacePath,
          uiTimeoutMs,
          modelResponseTimeoutMs,
          observeForegroundText: text => observeText(client, target, text, textTimeoutMs),
          mark,
          windowState,
          pids,
          concurrentResponses,
          getForegroundToolsSent: () => foregroundToolsSent,
          startConcurrent,
          finishConcurrent,
          streamMilestones,
        })
        await sampleHeap('ten-tasks')
        const measuredToolsSent = [...measuredBatches.values()].reduce(
          (sum, count) => sum + count * measuredToolBatch,
          0
        )
        assert.equal(
          measuredToolsSent,
          measuredToolTasks.size * measuredToolPieces.length * measuredToolBatch
        )
        assert.equal(
          reasoningDeltasSent,
          concurrentStreamPieces +
            measuredReasoningTasks.size * measuredToolPieces.length * measuredReasoningPieces
        )
        const measurements = {
          idleCpuPercent: cpuPercent(idleStart, idleEnd),
          singleTaskCpuPercent: cpuPercent(start, end),
          tenTaskCpuPercent: Math.max(...Object.values(concurrentCpuPercent)),
          maxTurnUpdateLongTaskMs: Math.max(...turnUpdates.map(update => update.longTaskMs)),
          peakObservedJsHeapBytes: Math.max(...samples.map(sample => sample.usedSize)),
        }
        const after = await windowState()
        const validPresentation = [
          before,
          after,
          foregroundWindow.before,
          foregroundWindow.after,
        ].every(state => state.activity === 'foreground')
        const report = {
          measurements,
          concurrentCpuPercent,
          turnUpdates,
          heapSamples: samples,
          processSamples,
          historicalTasks: measureHistory ? historyTaskCount : 0,
          savedTaskCount,
          projectIssueCount,
          foregroundToolsSent,
          measuredToolsSent,
          reasoningDeltasSent,
          rendererPids: pids,
          window: { before, after, foregroundConversation: foregroundWindow },
          validPresentation,
          capture,
          limits,
          withinLimits: capture
            ? null
            : validPresentation &&
              Object.entries(limits).every(([metric, limit]) => measurements[metric] < limit),
        }
        await writeDiagnosticFile(join(resultDir, 'renderer-threshold-measurements.json'), report)
        console.log('[renderer-profile]', JSON.stringify(measurements))
        assert.ok(validPresentation, 'The presentation path changed during the run')
        if (recording) {
          recording = false
          await stopPerformanceRecording(client, resultDir, target, reportPath)
        }
        if (process.env.WEWORK_RENDERER_PROFILE_CHECK === 'true') {
          assert.ok(
            report.withinLimits,
            'Renderer exceeds a limit; see renderer-threshold-measurements.json'
          )
        }
      } finally {
        try {
          if (probingTurnUpdates) await evaluate('window.__weworkProfileTurnUpdates?.stop()')
        } finally {
          try {
            if (recording) await stopPerformanceRecording(client, resultDir, target, reportPath)
          } finally {
            await client({ action: 'detach', target })
          }
        }
      }
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Usage: pnpm --filter wework profile:renderer [--capture | --check] [--history] [--processes] (macOS)'
    )
    return
  }
  assert.equal(process.platform, 'darwin', 'Renderer CPU counters require macOS')
  assert.ok(
    new Set(args).size === args.length &&
      args.every(arg => ['--capture', '--check', '--history', '--processes'].includes(arg)) &&
      !(args.includes('--capture') && args.includes('--check')),
    'Use --capture or --check, with optional --history and --processes'
  )
  const contents = fileURLToPath(
    new URL(
      `../electron/release/WeWork-darwin-${process.arch}/WeWork.app/Contents/`,
      import.meta.url
    )
  )
  const app = process.env.WEWORK_E2E_APP_BIN ?? join(contents, 'MacOS', 'WeWork')
  const executor =
    process.env.WEWORK_E2E_EXECUTOR_BIN ?? join(contents, 'Resources/bin/wegent-executor')
  for (const path of [app, executor]) {
    await access(path).catch(error => {
      throw new Error(`Build the verification bundle or provide the binary: ${path}`, {
        cause: error,
      })
    })
  }
  const runner = fileURLToPath(new URL('../e2e/desktop/task-flow.e2e.mjs', import.meta.url))
  const child = spawn(process.execPath, [runner, '--segment', 'streaming-conversation-switching'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      WEWORK_E2E_APP_BIN: app,
      WEWORK_E2E_EXECUTOR_BIN: executor,
      WEWORK_E2E_DESKTOP_SCENARIO_ONLY: 'true',
      WEWORK_E2E_BACKGROUND_WINDOW: '1',
      WEWORK_E2E_DESKTOP_SCENARIO_MODULE: import.meta.url,
      WEWORK_RENDERER_PROFILE_CAPTURE: String(args.includes('--capture')),
      WEWORK_RENDERER_PROFILE_CHECK: String(args.includes('--check')),
      WEWORK_RENDERER_PROFILE_HISTORY: String(args.includes('--history')),
      WEWORK_RENDERER_PROFILE_PROCESSES: String(args.includes('--processes')),
    },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
