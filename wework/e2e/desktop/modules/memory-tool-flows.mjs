import {
  captureMemorySample,
  captureTotalMemorySample,
  waitForNewTaskRow,
  waitForSnapshot,
} from './conversation-layout.mjs'

import {
  ACTIVE_WORKBENCH_SELECTOR,
  CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB,
  CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB,
  CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB,
  CONCURRENT_MEMORY_TASK_COUNT,
  DEFAULT_STEP_TIMEOUT_MS,
  EARLIER_TOOL_BLOCK_ID,
  GENERIC_MCP_TOOL_BLOCK_ID,
  LATER_TOOL_BLOCK_ID,
  MEMORY_COMPLETION_TEXT,
  MEMORY_MAX_BASELINE_SAMPLES,
  MEMORY_MAX_PEAK_GROWTH_KIB,
  MEMORY_MAX_SAMPLE_RANGE_KIB,
  MEMORY_MAX_SETTLED_DOM_NODE_GROWTH,
  MEMORY_MAX_SETTLED_GROWTH_KIB,
  MEMORY_MAX_SETTLED_SAMPLES,
  MEMORY_MIN_BASELINE_SAMPLES,
  MEMORY_MIN_SETTLED_SAMPLES,
  MEMORY_PROMPT,
  MEMORY_SAMPLE_INTERVAL_MS,
  MEMORY_SAMPLE_WINDOW_SIZE,
  NODE_REPL_TOOL_BLOCK_ID,
  TOOL_BLOCK_ORDER_COMPLETION_TEXT,
  TOOL_BLOCK_ORDER_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  resultDir,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  withTimeout,
  writeFile,
} from './shared.mjs'

import { captureVerificationScreenshot } from './workspace-flows.mjs'

async function ensureTaskRowVisible(control, taskRowTestId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await waitForSnapshot(
      control,
      value =>
        value.testIds.includes(taskRowTestId) ||
        value.testIds.some(testId => testId.startsWith('project-runtime-tasks-expand-')),
      `Unable to find task row ${taskRowTestId} or a project task expansion control`,
      WORKBENCH_READY_TIMEOUT_MS
    )
    if (snapshot.testIds.includes(taskRowTestId)) return
    const expandTasksButton = snapshot.testIds.find(testId =>
      testId.startsWith('project-runtime-tasks-expand-')
    )
    assert.ok(expandTasksButton)
    await control.command('click', `[data-testid="${expandTasksButton}"]`)
  }
  await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyExpandedToolDetail(
  control,
  { selector, detailText, inputText, outputText, screenshotName }
) {
  await control.command('click', `${selector} [data-tool-detail-toggle]`)
  await control.command('waitFor', `${selector} [data-testid="generic-tool-block-detail"]`, {
    text: detailText,
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', `${selector} [data-testid="generic-tool-input"]`, {
    text: inputText,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', `${selector} [data-testid="generic-tool-output"]`, {
    text: outputText,
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', `${selector} [data-tool-detail-toggle][aria-expanded="true"]`, {
    stableMs: 250,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, screenshotName, selector)
  await control.command('click', `${selector} [data-tool-detail-toggle]`)
}

async function ensureToggleExpanded(control, selector) {
  await control.command('waitFor', selector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const expandedCount = Number(
    await control.command('getElementCount', `${selector}[aria-expanded="true"]`)
  )
  if (expandedCount > 0) return
  await control.command('click', selector)
  await control.command('waitFor', `${selector}[aria-expanded="true"]`, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyToolBlockChronologicalOrder({ composerSelector, control }) {
  control.setScenario('tool_block_order')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    TOOL_BLOCK_ORDER_PROMPT,
    'tool_block_order'
  )

  await withTimeout(
    control.guard(control.toolBlockNodeOutputObserved),
    DEFAULT_STEP_TIMEOUT_MS,
    'The Node REPL output did not return to the real model request'
  )
  const nodeReplSelector = `[data-processing-block-id="${NODE_REPL_TOOL_BLOCK_ID}"]`
  await control.command('waitFor', nodeReplSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await verifyExpandedToolDetail(control, {
    selector: nodeReplSelector,
    detailText: 'node_repl.js',
    inputText: "nodeRepl.write({ status: 'ready', value: 42 })",
    outputText: "{ status: 'executed', result: 84 }",
    screenshotName: 'tool-block-details-02-node-repl-expanded.png',
  })
  control.releaseToolBlockNode()

  await withTimeout(
    control.guard(control.toolBlockGenericOutputObserved),
    DEFAULT_STEP_TIMEOUT_MS,
    'The generic MCP output did not return to the real model request'
  )
  const genericMcpSelector = `[data-processing-block-id="${GENERIC_MCP_TOOL_BLOCK_ID}"]`
  await control.command('waitFor', genericMcpSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await verifyExpandedToolDetail(control, {
    selector: genericMcpSelector,
    detailText: 'github__issues.get_issue_details',
    inputText: '"issue_number": 123',
    outputText: '"title": "Tool detail verification"',
    screenshotName: 'tool-block-details-03-generic-mcp-expanded.png',
  })
  control.releaseToolBlockGeneric()

  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: TOOL_BLOCK_ORDER_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureToggleExpanded(control, '[data-testid="final-processing-toggle"]')
  await ensureToggleExpanded(control, '[data-testid="processing-summary-toggle"]')

  const earlierSelector = `[data-processing-block-id="${EARLIER_TOOL_BLOCK_ID}"]`
  const laterSelector = `[data-processing-block-id="${LATER_TOOL_BLOCK_ID}"]`
  await control.command('waitFor', earlierSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', laterSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', nodeReplSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', genericMcpSelector, {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const [earlierMetrics] = JSON.parse(await control.command('getElementMetrics', earlierSelector))
  const [nodeReplMetrics] = JSON.parse(await control.command('getElementMetrics', nodeReplSelector))
  const [genericMcpMetrics] = JSON.parse(
    await control.command('getElementMetrics', genericMcpSelector)
  )
  const [laterMetrics] = JSON.parse(await control.command('getElementMetrics', laterSelector))
  assert.ok(
    earlierMetrics.top < nodeReplMetrics.top &&
      nodeReplMetrics.top < genericMcpMetrics.top &&
      genericMcpMetrics.top < laterMetrics.top,
    `Tool activities were not chronological (${earlierMetrics.top}, ${nodeReplMetrics.top}, ${genericMcpMetrics.top}, ${laterMetrics.top})`
  )
  await control.command('scrollIntoView', earlierSelector)
  await captureVerificationScreenshot(
    control,
    'tool-block-order-01-chronological.png',
    '[data-testid="final-processing-timeline"]'
  )
  await captureVerificationScreenshot(
    control,
    'tool-block-order-04-later-command.png',
    laterSelector
  )
}

async function waitForBlankConversation(control, composerSelector) {
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('message-user') && !snapshot.testIds.includes('message-assistant'),
    'The new task did not activate a blank conversation before input',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const startedAt = Date.now()
  let lastCurrentRuntimeTask
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const debugSnapshot = JSON.parse(
      await control.command('getWorkbenchDebugSnapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    lastCurrentRuntimeTask = debugSnapshot.workbench?.currentRuntimeTask
    if (lastCurrentRuntimeTask === null) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    `The new task did not clear the active runtime task before input: ${JSON.stringify(
      lastCurrentRuntimeTask
    )}`
  )
}

async function verifyConcurrentTaskMemory({ composerSelector, control }) {
  assert.equal(process.platform, 'darwin', 'Concurrent memory E2E currently requires macOS')
  control.setScenario('concurrent_memory')
  const baselineSamples = await captureStableTotalMemorySamples(control, 'baseline')
  const baseline = medianMemorySample(baselineSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE))
  assert.ok(baseline, 'The concurrent memory E2E did not capture a baseline')
  const taskRows = []
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const knownTaskRows = new Set(
    initialSnapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  )

  for (let index = 1; index <= CONCURRENT_MEMORY_TASK_COUNT; index += 1) {
    if (index > 1) {
      await control.command('click', '[data-testid="new-chat-button"]')
    }
    await waitForBlankConversation(control, composerSelector)
    const prompt = `WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_${index}`
    await control.command('fill', composerSelector, { value: prompt })
    await control.command('press', composerSelector, { key: 'Enter' })
    await control.awaitScenarioRequestCount('concurrent_memory', index)
    const nextRow = await waitForNewTaskRow(control, knownTaskRows, prompt)
    knownTaskRows.add(nextRow)
    taskRows.push(nextRow)
  }

  assert.equal(
    control.scenarioRequests.get('concurrent_memory')?.length,
    CONCURRENT_MEMORY_TASK_COUNT,
    'The model service did not keep ten task requests running concurrently'
  )
  assert.equal(
    control.concurrentMemoryTaskNumbers.size,
    CONCURRENT_MEMORY_TASK_COUNT,
    'The model service did not receive ten unique concurrent task prompts'
  )
  assert.ok(
    control.concurrentMemoryResponses.length >= CONCURRENT_MEMORY_TASK_COUNT,
    'The model service released a concurrent task stream before memory sampling'
  )
  assert.equal(
    taskRows.length,
    CONCURRENT_MEMORY_TASK_COUNT,
    'The sidebar did not expose ten tasks'
  )
  await captureVerificationScreenshot(control, 'concurrent-memory-01-running.png')

  const samples = []
  for (let index = 0; index < 5; index += 1) {
    samples.push(await captureTotalMemorySample(control, 'running'))
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  }
  const peak = samples.reduce((largest, sample) =>
    sample.physicalFootprintKiB > largest.physicalFootprintKiB ? sample : largest
  )
  const settledWindow = samples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
  const settled = medianMemorySample(settledWindow)
  assert.ok(settled, 'The concurrent memory E2E did not capture a settled sample window')
  const peakGrowthKiB = peak.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledGrowthKiB = settled.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledSampleRangeKiB = memorySampleRangeKiB(settledWindow)

  const sidebarSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const expandTasksButton = sidebarSnapshot.testIds.find(testId =>
    testId.startsWith('project-runtime-tasks-expand-')
  )
  if (expandTasksButton) {
    await control.command('click', `[data-testid="${expandTasksButton}"]`)
  }
  await control.command('waitFor', `[data-testid="${taskRows[0]}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRows[0]}"]`)
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    text: 'WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_1',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRows.at(-1)}"]`)
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    text: `WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_${CONCURRENT_MEMORY_TASK_COUNT}`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await writeFile(
    join(resultDir, 'concurrent-memory.json'),
    `${JSON.stringify(
      {
        taskCount: CONCURRENT_MEMORY_TASK_COUNT,
        limits: {
          maxPeakGrowthKiB: CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB,
          maxSettledGrowthKiB: CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB,
          maxSettledSampleRangeKiB: CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB,
        },
        summary: {
          baseline,
          peak,
          settled,
          peakGrowthKiB,
          settledGrowthKiB,
          settledSampleRangeKiB,
        },
        baselineSamples,
        samples,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  assert.ok(
    peakGrowthKiB <= CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB,
    `Wework physical footprint grew by ${peakGrowthKiB} KiB with ten concurrent tasks`
  )
  assert.ok(
    settledGrowthKiB <= CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB,
    `Wework physical footprint settled ${settledGrowthKiB} KiB above baseline with ten concurrent tasks`
  )
  assert.ok(
    settledSampleRangeKiB <= CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB,
    `Wework concurrent memory sample range reached ${settledSampleRangeKiB} KiB`
  )
  control.releaseConcurrentMemoryResponses()
}

async function verifyMemoryGrowth({ composerSelector, control }) {
  assert.equal(process.platform, 'darwin', 'Desktop memory E2E currently requires macOS')
  control.setScenario('memory')
  const baselineSamples = await captureStableMemorySamples(
    control,
    'baseline',
    MEMORY_MIN_BASELINE_SAMPLES,
    MEMORY_MAX_BASELINE_SAMPLES
  )
  const baseline = medianMemorySample(baselineSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE))
  assert.ok(baseline, 'The memory E2E did not capture baseline samples')
  const samples = [...baselineSamples]
  await captureVerificationScreenshot(control, 'memory-01-baseline.png')
  await sendPromptUntilScenarioRequest(control, composerSelector, MEMORY_PROMPT, 'memory')
  await captureVerificationScreenshot(control, 'memory-02-streaming.png')

  let completed = false
  const startedAt = Date.now()
  while (!completed && Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, MEMORY_SAMPLE_INTERVAL_MS))
    samples.push(await captureMemorySample(control, 'streaming'))
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    completed = snapshot.text.includes(MEMORY_COMPLETION_TEXT)
  }
  assert.equal(completed, true, 'The memory E2E response did not complete')
  await captureVerificationScreenshot(control, 'memory-03-completed.png')

  for (let index = 0; index < MEMORY_MAX_SETTLED_SAMPLES; index += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    samples.push(await captureMemorySample(control, 'settled'))
    const settledSamples = samples.filter(sample => sample.phase === 'settled')
    if (settledSamples.length < MEMORY_MIN_SETTLED_SAMPLES) continue
    const settledWindow = settledSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
    const settled = medianMemorySample(settledWindow)
    assert.ok(settled, 'The memory E2E did not capture a settled sample window')
    if (
      settled.physicalFootprintKiB - baseline.physicalFootprintKiB <=
        MEMORY_MAX_SETTLED_GROWTH_KIB &&
      memorySampleRangeKiB(settledWindow) <= MEMORY_MAX_SAMPLE_RANGE_KIB
    ) {
      break
    }
  }

  const workloadSamples = samples.filter(sample => sample.phase !== 'baseline')
  const peak = workloadSamples.reduce((largest, sample) =>
    sample.physicalFootprintKiB > largest.physicalFootprintKiB ? sample : largest
  )
  const peakDomNodeCount = Math.max(...samples.map(sample => sample.domNodeCount))
  const settledSamples = samples.filter(sample => sample.phase === 'settled')
  const settledWindow = settledSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
  const settled = medianMemorySample(settledWindow)
  assert.ok(settled, 'The memory E2E did not capture settled samples')
  await captureVerificationScreenshot(control, 'memory-04-settled.png')
  const peakGrowthKiB = peak.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledGrowthKiB = settled.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledRangeKiB = memorySampleRangeKiB(settledWindow)
  const baselineDomNodeCount = Math.max(
    ...baselineSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE).map(sample => sample.domNodeCount)
  )
  const settledDomNodeCount = Math.max(...settledWindow.map(sample => sample.domNodeCount))
  const settledDomNodeGrowth = settledDomNodeCount - baselineDomNodeCount

  await writeFile(
    join(resultDir, 'memory-growth.json'),
    `${JSON.stringify(
      {
        limits: {
          maxPeakGrowthKiB: MEMORY_MAX_PEAK_GROWTH_KIB,
          maxSettledGrowthKiB: MEMORY_MAX_SETTLED_GROWTH_KIB,
          maxSettledDomNodeGrowth: MEMORY_MAX_SETTLED_DOM_NODE_GROWTH,
        },
        summary: {
          peakGrowthKiB,
          settledGrowthKiB,
          settledRangeKiB,
          peakDomNodeCount,
          baselineDomNodeCount,
          settledDomNodeCount,
          settledDomNodeGrowth,
          baselineSampleCount: baselineSamples.length,
        },
        samples,
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  assert.ok(
    peakGrowthKiB <= MEMORY_MAX_PEAK_GROWTH_KIB,
    `WebContent peak physical footprint grew by ${peakGrowthKiB} KiB`
  )
  assert.ok(
    settledDomNodeGrowth <= MEMORY_MAX_SETTLED_DOM_NODE_GROWTH,
    `WebContent DOM retained ${settledDomNodeGrowth} additional nodes after rendering the long response`
  )
  assert.ok(
    settledGrowthKiB <= MEMORY_MAX_SETTLED_GROWTH_KIB,
    `WebContent settled physical footprint grew by ${settledGrowthKiB} KiB`
  )
  assert.ok(
    settledRangeKiB <= MEMORY_MAX_SAMPLE_RANGE_KIB,
    `WebContent settled sample range reached ${settledRangeKiB} KiB`
  )
}

async function captureStableMemorySamples(control, phase, minimumSamples, maximumSamples) {
  const samples = []
  while (samples.length < maximumSamples) {
    if (samples.length > 0) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    }
    samples.push(await captureMemorySample(control, phase))
    if (samples.length < minimumSamples) continue
    const recent = samples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
    if (memorySampleRangeKiB(recent) <= MEMORY_MAX_SAMPLE_RANGE_KIB) break
  }
  return samples
}

async function captureStableTotalMemorySamples(control, phase) {
  const samples = []
  while (samples.length < MEMORY_MAX_BASELINE_SAMPLES) {
    if (samples.length > 0) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    }
    samples.push(await captureTotalMemorySample(control, phase))
    if (samples.length < MEMORY_MIN_BASELINE_SAMPLES) continue
    const recent = samples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
    if (memorySampleRangeKiB(recent) <= MEMORY_MAX_SAMPLE_RANGE_KIB) break
  }
  return samples
}

function memorySampleRangeKiB(samples) {
  const footprints = samples.map(sample => sample.physicalFootprintKiB)
  return Math.max(...footprints) - Math.min(...footprints)
}

function medianMemorySample(samples) {
  if (samples.length === 0) return null
  return [...samples].sort((left, right) => left.physicalFootprintKiB - right.physicalFootprintKiB)[
    Math.floor(samples.length / 2)
  ]
}

async function waitForScenarioRequestCount(control, scenario, expectedCount) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const requestCount = control.scenarioRequests.get(scenario)?.length ?? 0
    if (requestCount >= expectedCount) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The model service did not receive ${expectedCount} ${scenario} requests`)
}

export {
  ensureTaskRowVisible,
  verifyExpandedToolDetail,
  ensureToggleExpanded,
  verifyToolBlockChronologicalOrder,
  waitForBlankConversation,
  verifyConcurrentTaskMemory,
  verifyMemoryGrowth,
  captureStableMemorySamples,
  captureStableTotalMemorySamples,
  memorySampleRangeKiB,
  medianMemorySample,
  waitForScenarioRequestCount,
}
