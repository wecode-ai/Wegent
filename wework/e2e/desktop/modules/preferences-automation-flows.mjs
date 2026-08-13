import { waitForSnapshot } from './conversation-layout.mjs'

import { telemetryEvents } from './response-protocol.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  AUTOMATION_COMPLETION_TEXT,
  AUTOMATION_NAME,
  AUTOMATION_PROMPT,
  AUTOMATION_SCHEDULE_TIMEOUT_MS,
  CLOUD_PUBLIC_MODEL_LABEL,
  CLOUD_PUBLIC_MODEL_NAME,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  TELEMETRY_FORBIDDEN_PROPERTY_PATTERN,
  TELEMETRY_SAFE_PROPERTY_KEYS,
  TELEMETRY_TEST_PROJECT_KEY,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  pathExists,
  readFile,
  relative,
} from './shared.mjs'

import { captureVerificationScreenshot, waitForAttribute } from './workspace-flows.mjs'

async function waitForTelemetrySilence(control, options = {}) {
  const { intervalMs = 100, silenceMs = 500, maxWaitMs = 3_500 } = options
  const start = Date.now()
  let lastCount = control.telemetryRequestCount()
  let lastChange = start
  while (Date.now() - start < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    const currentCount = control.telemetryRequestCount()
    if (currentCount !== lastCount) {
      lastCount = currentCount
      lastChange = Date.now()
      continue
    }
    if (Date.now() - lastChange >= silenceMs) {
      return currentCount
    }
  }
  return lastCount
}

async function verifyTelemetryPreference(control) {
  const toggleSelector = '[data-testid="general-telemetry-toggle"]'
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('waitFor', toggleSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', toggleSelector, { value: 'aria-checked' }),
    'true',
    'Accepting the first-run telemetry prompt was not persisted'
  )
  await control.command('click', toggleSelector)
  await waitForAttribute(
    control,
    toggleSelector,
    'aria-checked',
    'false',
    'Disabling telemetry was not persisted'
  )
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForTelemetrySilence(control)
  control.telemetryRequestCountAfterRevocation = control.telemetryRequestCount()
  assert.equal(
    control.telemetryRequestCount(),
    control.telemetryRequestCountAfterRevocation,
    'PostHog flushed telemetry after the user revoked consent'
  )
}

function verifyTelemetryRemainsDisabled(control) {
  assert.notEqual(
    control.telemetryRequestCountAfterRevocation,
    undefined,
    'The telemetry revocation checkpoint did not record its request boundary'
  )
  assert.equal(
    control.telemetryRequestCount(),
    control.telemetryRequestCountAfterRevocation,
    'Telemetry was sent after the user revoked consent'
  )
}

async function verifyInitialTelemetryConsent(control, sensitiveValues) {
  const overlaySelector = '[data-testid="telemetry-consent-overlay"]'
  await control.command('waitFor', overlaySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 750))
  assert.equal(
    control.telemetryRequestCount(),
    0,
    'Telemetry was sent before the user made an explicit consent choice'
  )

  await control.command('click', '[data-testid="telemetry-consent-accept"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('telemetry-consent-overlay'),
    'The first-run telemetry consent prompt did not close after accepting'
  )

  await control.awaitTelemetryEvent('app_started')
  const requests = control.telemetryRequests
  const events = requests.flatMap(request => telemetryEvents(request.payload))
  assert.ok(events.length > 0, 'The telemetry request did not contain an event')
  const appStarted = events.find(event => event.event === 'app_started')
  assert.ok(appStarted, 'The first telemetry request did not include app_started')
  assert.equal(appStarted.properties?.surface, 'main')

  for (const event of events) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        {
          app_started: true,
          feature_opened: true,
          telemetry_preference_changed: true,
        },
        event.event
      ),
      true,
      `The initial telemetry request contained an unexpected event: ${event.event}`
    )
    assert.ok(event.properties && typeof event.properties === 'object')
    for (const propertyName of Object.keys(event.properties)) {
      assert.equal(
        TELEMETRY_SAFE_PROPERTY_KEYS.has(propertyName),
        true,
        `Telemetry sent a property outside the privacy allowlist: ${propertyName}`
      )
      if (propertyName === 'token') {
        assert.equal(
          event.properties[propertyName],
          TELEMETRY_TEST_PROJECT_KEY,
          'Telemetry sent an unexpected PostHog project key'
        )
      } else if (propertyName === '$process_person_profile') {
        assert.equal(
          event.properties[propertyName],
          false,
          'Telemetry attempted to create or update a PostHog person profile'
        )
      } else {
        assert.equal(
          TELEMETRY_FORBIDDEN_PROPERTY_PATTERN.test(propertyName),
          false,
          `Telemetry sent a potentially sensitive property: ${propertyName}`
        )
      }
    }
    assert.equal(event.$set, undefined, 'Telemetry sent person profile properties')
    assert.equal(event.$set_once, undefined, 'Telemetry sent persistent person properties')
  }

  for (const sensitiveValue of sensitiveValues.filter(Boolean)) {
    assert.equal(
      requests.some(request => request.rawBody.includes(String(sensitiveValue))),
      false,
      `Telemetry leaked a sensitive runtime value: ${String(sensitiveValue).slice(0, 24)}`
    )
  }
}

async function declineInitialTelemetryConsent(control) {
  const overlaySelector = '[data-testid="telemetry-consent-overlay"]'
  await control.command('waitFor', overlaySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="telemetry-consent-decline"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('telemetry-consent-overlay'),
    'The first-run telemetry consent prompt did not close after declining'
  )
}

async function ensureExperimentalFeaturesEnabled(control) {
  const toggleSelector = '[data-testid="general-experimental-features-toggle"]'
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('waitFor', toggleSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (
    (await control.command('getAttribute', toggleSelector, { value: 'aria-checked' })) !== 'true'
  ) {
    await control.command('click', toggleSelector)
    await waitForAttribute(
      control,
      toggleSelector,
      'aria-checked',
      'true',
      'Enabling experimental features was not persisted'
    )
  }
  await control.command('click', '[data-testid="settings-back-button"]')
}

async function verifyAutomationLifecycle(control, executorHome, homePath) {
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    initialSnapshot.testIds.includes('automation-button'),
    'Automations remained hidden behind the experimental-features preference'
  )
  await control.command('click', '[data-testid="automation-button"]')
  await control.command('waitFor', '[data-testid="create-automation-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="create-automation-button"]')
  await control.command('waitFor', '[data-testid="automation-detail-panel"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="automation-name-input"]', {
    value: AUTOMATION_NAME,
  })
  await control.command('fill', '[data-testid="automation-prompt-input"]', {
    value: AUTOMATION_PROMPT,
  })
  await control.command('click', '[data-testid="automation-model-select"]')
  await control.command(
    'click',
    `[data-testid="automation-model-select-option-public:desktop-e2e-public-upstream-model"]`
  )
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(CLOUD_PUBLIC_MODEL_LABEL),
    'The automation did not select the cloud model'
  )
  await control.command('click', '[data-testid="automation-goal-switch"]')
  await waitForAttribute(
    control,
    '[data-testid="automation-goal-switch"]',
    'aria-checked',
    'true',
    'Enabling the automation goal was not persisted'
  )
  await captureVerificationScreenshot(control, 'automations-01-goal-configured.png')
  await control.command('click', '[data-testid="automation-project-select"]')
  await control.command('click', '[data-testid="automation-project-select-option-"]')
  const draftSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !draftSnapshot.testIds.includes('automation-workspace-input'),
    'Automation creation should derive its working directory instead of exposing a path input'
  )
  await control.command('click', '[data-testid="automation-source-select"]')
  await assert.rejects(
    control.command('click', '[data-testid="automation-source-select-option-cloud"]'),
    /disabled/,
    'The cloud automation source remained selectable'
  )
  const sourceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    sourceSnapshot.testIds.includes('automation-source-select-menu'),
    'The automation source menu closed after clicking the disabled cloud option'
  )
  await control.command('click', '[data-testid="automation-source-select"]')
  await control.command('click', '[data-testid="automation-conversation-mode"]')
  await control.command(
    'click',
    '[data-testid="automation-conversation-mode-option-continue_thread"]'
  )
  await control.command('click', '[data-testid="automation-target-task-select"]')
  const existingTaskEmptySnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes('目标任务') &&
      snapshot.text.includes('请先置顶一个本地任务，再使用已安排任务') &&
      snapshot.text.includes('现有任务') &&
      !snapshot.text.includes('继续当前任务'),
    'The existing-task selector did not match the ChatGPT pinned-task empty state'
  )
  assert.ok(
    existingTaskEmptySnapshot.text.includes('选择一个已固定任务'),
    'The existing-task selector did not use the ChatGPT trigger copy'
  )
  const [targetTaskMenuMetrics] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="automation-target-task-select-menu"]')
  )
  assert.ok(
    targetTaskMenuMetrics.width >= 340,
    `The existing-task menu was too narrow: ${targetTaskMenuMetrics.width}px`
  )
  assert.ok(
    targetTaskMenuMetrics.scrollWidth <= targetTaskMenuMetrics.clientWidth + 1,
    'The existing-task empty state overflowed horizontally'
  )
  await captureVerificationScreenshot(control, 'automations-00-existing-task-empty.png')
  await control.command('click', '[data-testid="automation-target-task-select"]')
  await control.command('click', '[data-testid="automation-conversation-mode"]')
  await control.command('click', '[data-testid="automation-conversation-mode-option-independent"]')
  await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const createdSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(AUTOMATION_NAME) &&
      snapshot.testIds.some(testId => testId.startsWith('automation-open-')),
    'The local automation was not persisted by the Executor'
  )
  const automationRow = createdSnapshot.testIds.find(testId =>
    testId.startsWith('automation-open-')
  )
  assert.ok(automationRow, 'The automation row did not expose a stable test id')
  const automationActions = createdSnapshot.testIds.find(testId =>
    testId.startsWith('automation-detail-actions-')
  )
  assert.ok(automationActions, 'The automation detail did not expose its actions menu')
  assert.equal(
    await control.command('getAttribute', '[data-testid="automation-goal-switch"]', {
      value: 'aria-checked',
    }),
    'true',
    'The persisted automation did not restore goal mode'
  )
  const automationStore = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'automations.json'), 'utf8')
  )
  const storedAutomation = Object.values(automationStore.automations ?? {}).find(
    item => item.name === AUTOMATION_NAME
  )
  assert.equal(
    storedAutomation?.taskPayload?.initialGoal?.objective,
    AUTOMATION_PROMPT,
    'The Executor did not persist the scheduled task goal in its runtime payload'
  )
  assert.deepEqual(
    {
      modelId: storedAutomation?.taskPayload?.modelId,
      modelType: storedAutomation?.taskPayload?.modelType,
      modelOptions: storedAutomation?.taskPayload?.modelOptions,
    },
    {
      modelId: CLOUD_PUBLIC_MODEL_NAME,
      modelType: 'public',
      modelOptions: {
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
        reasoningEffort: 'medium',
      },
    },
    'The Executor did not persist the complete cloud model identity'
  )
  assert.deepEqual(
    storedAutomation?.taskPayload?.executionRequest?.model_config?.default_headers,
    {
      'X-Wegent-Model-Type': 'public',
      'X-Wegent-Model-Namespace': 'default',
      'X-Wegent-Model-User-Id': '0',
      'X-Wegent-Upstream-Header-wecode-executor': 'codex',
      'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
    },
    'The automation execution config did not route the complete cloud model identity'
  )
  await captureVerificationScreenshot(control, 'automations-02-goal-persisted.png')

  const previousScenario = control.scenario
  control.setScenario('automation')
  try {
    await control.command('click', `[data-testid="${automationActions}"]`)
    await control.command('click', '[data-testid="automation-run-now-button"]')
    await control.awaitScenarioRequestCount('automation', 2, WORKBENCH_READY_TIMEOUT_MS)

    const manualTaskSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.text.includes(`${AUTOMATION_COMPLETION_TEXT}_1`) ||
        snapshot.testIds.some(
          testId =>
            testId.startsWith('runtime-local-task-row-') &&
            !initialSnapshot.testIds.includes(testId)
        ),
      'The manual automation run did not expose its completed runtime task',
      WORKBENCH_READY_TIMEOUT_MS
    )
    const manualTaskRow = manualTaskSnapshot.testIds.find(
      testId =>
        testId.startsWith('runtime-local-task-row-') && !initialSnapshot.testIds.includes(testId)
    )
    assert.ok(manualTaskRow, 'The manual automation run did not expose its runtime task')
    const manualTaskId = manualTaskRow.replace('runtime-local-task-row-', '')
    const runtimeIndex = JSON.parse(
      await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    )
    const standaloneWorkspacePath = runtimeIndex.tasks[manualTaskId]?.workspace_path
    assert.equal(
      typeof standaloneWorkspacePath,
      'string',
      'The projectless automation task was grouped under a project workspace'
    )
    const standaloneWorkspaceSegments = relative(
      join(homePath, 'Documents', 'Codex'),
      standaloneWorkspacePath
    ).split(/[/\\]/)
    assert.match(
      standaloneWorkspaceSegments[0],
      /^\d{4}-\d{2}-\d{2}$/,
      'The standalone automation workspace did not use a dated directory'
    )
    assert.deepEqual(
      standaloneWorkspaceSegments.slice(1),
      [manualTaskId],
      'The projectless automation task was grouped under a project workspace'
    )
    assert.equal(
      await pathExists(standaloneWorkspacePath),
      true,
      `The projectless automation did not create a standalone workspace: ${standaloneWorkspacePath}`
    )
    if (!manualTaskSnapshot.text.includes(`${AUTOMATION_COMPLETION_TEXT}_1`)) {
      await control.command('click', `[data-testid="${manualTaskRow}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: `${AUTOMATION_COMPLETION_TEXT}_1`,
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
    }
    await control.command('click', '[data-testid="automation-button"]')
    await control.command('waitFor', `[data-testid="${automationRow}"]`, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', `[data-testid="${automationRow}"]`)
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(testId => testId.startsWith('automation-run-status-')) &&
        /Completed|已完成/.test(snapshot.text),
      'The manual automation run did not update its run history to completed',
      WORKBENCH_READY_TIMEOUT_MS
    )
    await captureVerificationScreenshot(control, 'automations-03-manual-goal-complete.png')
    const manualTaskMark = `runtime-local-task-mark-${manualTaskId}`
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(manualTaskMark) &&
        snapshot.testIds.includes('send-message-button') &&
        !snapshot.testIds.includes(`runtime-local-task-running-${manualTaskId}`),
      'The completed automation task did not become available for pinning'
    )
    await control.command('click', `[data-testid="${manualTaskMark}"]`)
    await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.includes('sidebar-pinned-section'),
      'The automation task was not pinned before testing existing-task mode'
    )

    await control.command('click', '[data-testid="automation-conversation-mode"]')
    await control.command(
      'click',
      '[data-testid="automation-conversation-mode-option-continue_thread"]'
    )
    await control.command('click', '[data-testid="automation-target-task-select"]')
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes(
          `automation-target-task-select-option-local-device:${manualTaskId}`
        ),
      'The existing-task selector did not list the pinned local task'
    )
    await control.command(
      'click',
      `[data-testid="automation-target-task-select-option-local-device:${manualTaskId}"]`
    )
    await control.command('click', '[data-testid="automation-repeat-menu"]')
    await control.command('click', '[data-testid="automation-repeat-menu-option-one_time"]')
    const scheduledFor = new Date(Date.now() + 5_000)
    const localScheduledFor = new Date(
      scheduledFor.getTime() - scheduledFor.getTimezoneOffset() * 60_000
    )
      .toISOString()
      .slice(0, 19)
    await control.command('fill', '[data-testid="automation-execute-at-input"]', {
      value: localScheduledFor,
    })
    await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    const beforeScheduledRun = JSON.parse(await control.command('snapshot', 'body'))
    await control.awaitScenarioRequestCount('automation', 4, AUTOMATION_SCHEDULE_TIMEOUT_MS)
    await waitForSnapshot(
      control,
      snapshot => {
        const completedRuns = snapshot.testIds.filter(testId =>
          testId.startsWith('automation-run-status-')
        ).length
        const completedLabels = snapshot.text.match(/Completed|已完成/g)?.length ?? 0
        const newTask = snapshot.testIds.some(
          testId =>
            testId.startsWith('runtime-local-task-row-') &&
            !beforeScheduledRun.testIds.includes(testId)
        )
        return completedRuns >= 2 && completedLabels >= 2 && !newTask
      },
      'The scheduled automation did not continue the pinned task after becoming due',
      AUTOMATION_SCHEDULE_TIMEOUT_MS
    )
    await captureVerificationScreenshot(control, 'automations-04-scheduled-goal-complete.png')
    await control.command('click', `[data-testid="${manualTaskRow}"]`)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${AUTOMATION_COMPLETION_TEXT}_2`,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })

    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('click', '[data-testid="automation-button"]')
    await control.command('waitFor', `[data-testid="${automationRow}"]`, {
      text: AUTOMATION_NAME,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'automations-05-local-persisted.png')
  } finally {
    control.setScenario(previousScenario)
  }
}

async function verifyCloudAutomationLifecycle(control, cloudDeviceId) {
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    initialSnapshot.testIds.includes('automation-button'),
    'Automations remained hidden behind the experimental-features preference'
  )
  await control.command('click', '[data-testid="automation-button"]')
  await control.command('waitFor', '[data-testid="create-automation-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="create-automation-button"]')
  await control.command('waitFor', '[data-testid="automation-detail-panel"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="automation-name-input"]', {
    value: `${AUTOMATION_NAME} Cloud`,
  })
  await control.command('fill', '[data-testid="automation-prompt-input"]', {
    value: AUTOMATION_PROMPT,
  })

  await control.command('click', '[data-testid="automation-source-select"]')
  await control.command('click', '[data-testid="automation-source-select-option-cloud"]')
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes('Wework E2E Cloud Device') &&
      (snapshot.text.includes('云端') || snapshot.text.includes('Cloud')),
    'The cloud automation source did not select the remote executor'
  )

  await control.command('click', '[data-testid="automation-device-select"]')
  const deviceSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(`automation-device-select-option-${cloudDeviceId}`),
    'The cloud automation device selector did not list the remote executor'
  )
  assert.ok(
    deviceSnapshot.text.includes('Wework E2E Cloud Device'),
    'The cloud automation device selector did not show the remote executor name'
  )
  await control.command('click', `[data-testid="automation-device-select-option-${cloudDeviceId}"]`)

  await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const createdSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(`${AUTOMATION_NAME} Cloud`) &&
      snapshot.testIds.some(testId => testId.startsWith('automation-open-')),
    'The cloud automation was not persisted by the remote Executor'
  )
  const automationActions = createdSnapshot.testIds.find(testId =>
    testId.startsWith('automation-detail-actions-')
  )
  assert.ok(automationActions, 'The cloud automation detail did not expose its actions menu')

  const previousScenario = control.scenario
  control.setScenario('automation')
  try {
    await control.command('click', `[data-testid="${automationActions}"]`)
    await control.command('click', '[data-testid="automation-run-now-button"]')
    await control.awaitScenarioRequestCount('automation', 1, WORKBENCH_READY_TIMEOUT_MS)

    const taskSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.text.includes(`${AUTOMATION_COMPLETION_TEXT}_1`) ||
        snapshot.testIds.some(
          testId =>
            testId.startsWith('runtime-local-task-row-') &&
            !initialSnapshot.testIds.includes(testId)
        ),
      'The cloud automation run did not expose its completed runtime task',
      WORKBENCH_READY_TIMEOUT_MS
    )
    const taskRow = taskSnapshot.testIds.find(
      testId =>
        testId.startsWith('runtime-local-task-row-') && !initialSnapshot.testIds.includes(testId)
    )
    assert.ok(taskRow, 'The cloud automation run did not expose its runtime task')
    if (!taskSnapshot.text.includes(`${AUTOMATION_COMPLETION_TEXT}_1`)) {
      await control.command('click', `[data-testid="${taskRow}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: `${AUTOMATION_COMPLETION_TEXT}_1`,
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
    }
    const debugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    assert.equal(
      debugSnapshot.workbench?.currentRuntimeTask?.deviceId,
      cloudDeviceId,
      'The cloud automation task ran on the local device'
    )
    await captureVerificationScreenshot(control, 'automations-03-cloud-complete.png')
  } finally {
    control.setScenario(previousScenario)
  }
}

async function verifySitesPluginAutoInstall(control) {
  assert.equal(
    control.sitesConnectionBootstrapRequests,
    0,
    'Connecting the cloud account unexpectedly initialized the Sites plugin'
  )

  await control.command('navigate', 'body', { value: '/sites' })
  await control.command('waitFor', '[data-testid="sites-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="site-row-prj_e2e_product"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="applications-tab-miniapp"]')
  await control.command('waitFor', '[data-testid="mini-program-row-prj_e2e_mini"]', {
    text: 'E2E Mini Program',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'plugins-05-applications-mini-program-list.png')

  await control.command('clickWhenEnabled', '[data-testid="sites-create-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const miniProgramInstallRequestsBefore = control.httpRequests.filter(
    request =>
      request.method === 'POST' &&
      request.pathname === '/api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed'
  ).length
  await control.command('clickWhenEnabled', '[data-testid="sites-create-mini-program-menu-item"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes('创建并发布一个小程序'),
    'Creating a Mini Program did not place the requested application prompt in the composer',
    WORKBENCH_READY_TIMEOUT_MS,
    ACTIVE_COMPOSER_SELECTOR
  )
  const composerText = await control.command('getText', ACTIVE_COMPOSER_SELECTOR)
  assert.match(
    composerText,
    /创建并发布一个小程序/,
    'Creating a Mini Program did not place the requested application prompt in the composer'
  )
  const miniProgramInstallRequestsAfter = control.httpRequests.filter(
    request =>
      request.method === 'POST' &&
      request.pathname === '/api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed'
  ).length
  assert.equal(
    miniProgramInstallRequestsAfter - miniProgramInstallRequestsBefore,
    1,
    'Creating a Mini Program did not install its application plugin on demand'
  )
  await control.command('navigate', 'body', { value: '/sites' })
  await control.command('waitFor', '[data-testid="sites-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="applications-tab-miniapp"]')
  await control.command('waitFor', '[data-testid="mini-program-row-prj_e2e_mini"]', {
    text: 'E2E Mini Program',
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const miniProgramReuseRequestsBefore = control.httpRequests.filter(
    request =>
      request.method === 'POST' &&
      request.pathname === '/api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed'
  ).length
  await control.command('clickWhenEnabled', '[data-testid="sites-create-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="sites-create-mini-program-menu-item"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    reuseSnapshot => reuseSnapshot.text.includes('创建并发布一个小程序'),
    'Recreating a Mini Program did not reuse the installed application plugin',
    WORKBENCH_READY_TIMEOUT_MS,
    ACTIVE_COMPOSER_SELECTOR
  )
  const miniProgramReuseRequestsAfter = control.httpRequests.filter(
    request =>
      request.method === 'POST' &&
      request.pathname === '/api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed'
  ).length
  assert.equal(
    miniProgramReuseRequestsAfter - miniProgramReuseRequestsBefore,
    0,
    'Creating a Mini Program again should reuse the installed application plugin'
  )
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    snapshot.testIds.includes('sites-create-error'),
    false,
    'The Sites page reported an installation error after opening the plugin in chat'
  )
  await captureVerificationScreenshot(control, 'plugins-05-application-plugin-installed.png')

  const miniProgramPluginSelector =
    '[data-testid="composer-plugin-chip-weibo-miniapp-h5-develop-agent"]'
  await control.command('waitFor', miniProgramPluginSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', miniProgramPluginSelector)
  await control.command('waitFor', '[data-testid="plugin-detail-back-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    detailSnapshot =>
      detailSnapshot.text.includes('小程序') &&
      detailSnapshot.testIds.includes('plugin-detail-back-button'),
    'Clicking the Mini Program plugin mention did not open its plugin detail page'
  )
  await captureVerificationScreenshot(control, 'plugins-06-mini-program-detail.png')
}

function sitesMarketplacePlugin(installed) {
  return {
    id: 501,
    remotePluginId: 'wegent~Plugin_501',
    name: 'wegent-sites',
    displayName: '站点',
    description: 'Build and deploy websites with Wegent Sites',
    version: '0.1.0',
    author: 'Wegent Team',
    visibility: 'public',
    featured: true,
    installed,
    enabled: installed,
    installedPluginId: installed ? 601 : null,
    sourceType: 'marketplace',
    interface: {
      displayName: '站点',
      shortDescription: 'Build and deploy sites with Wegent',
      category: 'Productivity',
      defaultPrompt: ['Build an internal website and validate it locally'],
    },
    components: {
      skills: [
        {
          name: 'sites:sites-building',
          description: 'Build and validate sites',
          path: 'skills/sites-building/SKILL.md',
        },
      ],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    manifest: { name: 'wegent-sites' },
    ownerUserId: 0,
  }
}

function installedSitesPlugin() {
  const marketplacePlugin = sitesMarketplacePlugin(true)
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'wegent-sites',
      namespace: 'default',
      labels: { id: '601' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-marketplace',
        pluginKey: 'wegent-sites',
        catalogItemId: '501',
        marketplace: 'wegent',
      },
      displayName: '站点',
      description: marketplacePlugin.description,
      version: marketplacePlugin.version,
      author: marketplacePlugin.author,
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: marketplacePlugin.manifest,
      components: marketplacePlugin.components,
      interface: marketplacePlugin.interface,
      packageRef: {
        storageKey: 'skill-binaries/601',
        checksum: 'sha256:desktop-e2e-sites',
        sizeBytes: 1024,
      },
      sourcePayload: { filename: 'wegent-sites.zip' },
    },
    status: { state: 'Available' },
  }
}

function miniProgramMarketplacePlugin(installed) {
  return {
    id: 502,
    remotePluginId: 'wegent~Plugin_502',
    name: 'weibo-miniapp-h5-develop-agent',
    displayName: '微博小程序开发助手',
    description: 'Build and publish mini programs',
    version: '0.1.0',
    author: 'Wegent Team',
    visibility: 'public',
    featured: true,
    installed,
    enabled: installed,
    installedPluginId: installed ? 602 : null,
    sourceType: 'marketplace',
    interface: {
      displayName: '微博小程序开发助手',
      shortDescription: 'Build and publish mini programs with Wegent',
      category: 'Productivity',
      defaultPrompt: ['创建并发布一个小程序'],
    },
    components: {
      skills: [
        {
          name: 'mini-program:building',
          description: 'Build and publish mini programs',
          path: 'skills/building/SKILL.md',
        },
      ],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    manifest: { name: 'weibo-miniapp-h5-develop-agent' },
    ownerUserId: 0,
  }
}

function installedMiniProgramPlugin() {
  const marketplacePlugin = miniProgramMarketplacePlugin(true)
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'weibo-miniapp-h5-develop-agent',
      namespace: 'default',
      labels: { id: '602' },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-marketplace',
        pluginKey: 'weibo-miniapp-h5-develop-agent',
        catalogItemId: '502',
        marketplace: 'wegent',
      },
      displayName: '微博小程序开发助手',
      description: marketplacePlugin.description,
      version: marketplacePlugin.version,
      author: marketplacePlugin.author,
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: marketplacePlugin.manifest,
      components: marketplacePlugin.components,
      interface: marketplacePlugin.interface,
      packageRef: {
        storageKey: 'skill-binaries/602',
        checksum: 'sha256:desktop-e2e-mini-program',
        sizeBytes: 1024,
      },
      sourcePayload: { filename: 'weibo-miniapp-h5-develop-agent.zip' },
    },
    status: {
      state: 'Available',
      devices: [{ deviceId: 'local-device', state: 'installed' }],
    },
  }
}

export {
  waitForTelemetrySilence,
  verifyTelemetryPreference,
  verifyTelemetryRemainsDisabled,
  verifyInitialTelemetryConsent,
  declineInitialTelemetryConsent,
  ensureExperimentalFeaturesEnabled,
  verifyAutomationLifecycle,
  verifyCloudAutomationLifecycle,
  verifySitesPluginAutoInstall,
  sitesMarketplacePlugin,
  installedSitesPlugin,
  miniProgramMarketplacePlugin,
  installedMiniProgramPlugin,
}
