import {
  installedMiniProgramPlugin,
  installedSitesPlugin,
  miniProgramMarketplacePlugin,
  sitesMarketplacePlugin,
} from './preferences-automation-flows.mjs'

import {
  assistantMessage,
  codexRequestKind,
  cors,
  createSse,
  customToolCall,
  encryptedReasoningItem,
  functionCall,
  json,
  latestModelInputText,
  localModelSwitchCommand,
  localProtocolCase,
  localProtocolPatch,
  localProtocolPrompt,
  matrixCaseId,
  matrixPatch,
  matrixTextCompletion,
  matrixTextPrompt,
  matrixToolCompletion,
  matrixToolPreamble,
  matrixToolPrompt,
  namespacedFunctionCall,
  parseTelemetryPayload,
  readRawRequestBody,
  readRequestBody,
  requestAdvertisesShellTool,
  requestAdvertisesViewImageTool,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  responseFailed,
  selectApplyPatchTool,
  selectCloudApplyPatchTool,
  selectConvertedTool,
  selectMcpTool,
  selectOfficialPluginMcpTool,
  selectShellTool,
  selectShellToolCommand,
  selectTool,
  selectToolSearch,
  toolSearchResponseEvents,
  selectViewImageTool,
  streamingMarkdownReport,
  streamingTextEvents,
  telemetryEvents,
} from './response-protocol.mjs'
import { tmpdir } from 'node:os'

import {
  ANTHROPIC_EMPTY_COMPLETION_TEXT,
  ANTHROPIC_EMPTY_PROMPT,
  ATTACHMENT_ONLY_COMPLETION_TEXT,
  ATTACHMENT_ONLY_FILENAME,
  AUTOMATION_COMPLETION_TEXT,
  AUTOMATION_PROMPT,
  BACKGROUND_COMPLETION_RESTORE_PROMPT,
  BACKGROUND_COMPLETION_RESTORE_TEXT,
  BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
  BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  BLOCKED_CLOUD_MODEL_PATH,
  BACKGROUND_GUIDANCE_CONTINUATION,
  CANCELLATION_COMPLETION_TEXT,
  CANCELLATION_PROMPT,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  CLOUD_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_MODEL_CASES,
  CLOUD_PUBLIC_MODEL_LABEL,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_TASK_PROMPT,
  CLOUD_VISION_SIDECAR_CASE,
  CLOUD_MULTIMODAL_VISION_CASE,
  COMPLETION_TEXT,
  CONCURRENT_MEMORY_TASK_COUNT,
  CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
  CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  CUSTOM_TOOL_INPUT_DESCRIPTION,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS,
  DESKTOP_CONTROL_RESULT_GRACE_MS,
  DESKTOP_CONTROL_SERVER_PORT,
  DESKTOP_MODEL_SERVER_PORT,
  DROPPED_PATH_COMPLETION_TEXT,
  DROPPED_PATH_FILE_NAME,
  DROPPED_PATH_FOLDER_NAME,
  EARLIER_TOOL_BLOCK_ID,
  EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT,
  EMBEDDED_BROWSER_SETUP_PROMPT,
  FILE_PANEL_ANCHOR_PROMPT,
  FILE_PANEL_ANCHOR_RESPONSE,
  FILE_PANEL_LINK_NAME,
  FOLLOW_UP_COMPLETION_TEXT,
  FOLLOW_UP_PROMPT,
  FORK_ENCRYPTED_CONTENT,
  FORK_FOLLOW_UP_COMPLETION_TEXT,
  FORK_FOLLOW_UP_PROMPT,
  FRESH_CHAT_COMPLETION_TEXT,
  FRESH_CHAT_PROMPT,
  GENERIC_MCP_TOOL_BLOCK_ID,
  GENERIC_MCP_TOOL_SEARCH_ID,
  GOAL_BUSY_COMPLETION_TEXT,
  GOAL_BUSY_OBJECTIVE,
  GOAL_BUSY_PLAN_PROMPT,
  GOAL_BUSY_PLAN_TEXT,
  GOAL_IDLE_COMPLETION_TEXT,
  GOAL_IDLE_INITIAL_TEXT,
  GOAL_IDLE_PROMPT,
  GOAL_RESTART_COMPLETION_TEXT,
  GOAL_RESTART_INITIAL_TEXT,
  GOAL_RESTART_PROMPT,
  GUIDANCE_SCROLL_ACTIVE_PROMPT,
  GUIDANCE_SCROLL_COMPLETION_TEXT,
  GUIDANCE_SCROLL_PRE_TOOL_TEXT,
  GUIDANCE_SCROLL_PROMPT,
  GUIDANCE_SCROLL_RESPONSE,
  LATER_TOOL_BLOCK_ID,
  LOCAL_MARKDOWN_IMAGE_ALT,
  LOCAL_MARKDOWN_IMAGE_FILENAME,
  LOCAL_MARKDOWN_IMAGE_PROMPT,
  LOCAL_MODEL_CASES,
  LOCAL_MODEL_SWITCH_COMPLETE,
  LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT,
  LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
  LOCAL_MODEL_SWITCH_INITIAL_PROMPT,
  LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
  LOCAL_VISION_SIDECAR_CASE,
  MEMORY_PROMPT,
  MCP_ELICITATION_ACCEPTED_MARKER,
  MCP_ELICITATION_CALL_ID,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_NAMESPACE,
  MCP_ELICITATION_PROMPT,
  MCP_ELICITATION_SEARCH_ID,
  MCP_ELICITATION_TOOL_NAME,
  MESSAGE_EDIT_ORIGINAL_COMPLETION_TEXT,
  MESSAGE_EDIT_ORIGINAL_PROMPT,
  MESSAGE_EDIT_UPDATED_COMPLETION_TEXT,
  MESSAGE_EDIT_UPDATED_PROMPT,
  MODEL_API_KEY,
  NODE_REPL_TOOL_BLOCK_ID,
  NODE_REPL_TOOL_SEARCH_ID,
  OFFICIAL_PLUGIN_COMPLETION_TEXT,
  OFFICIAL_PLUGIN_DISPLAY_NAME,
  OFFICIAL_PLUGIN_MCP_SEARCH_ID,
  OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION,
  OFFICIAL_PLUGIN_NAME,
  OFFICIAL_PLUGIN_SKILL_MARKER,
  OFFICIAL_PLUGIN_SKILL_NAME,
  OFFICIAL_PLUGIN_SKILL_READY_TEXT,
  PASTED_PATH_COMPLETION_TEXT,
  PASTED_PATH_FILE_NAME,
  PASTED_PATH_FOLDER_NAME,
  PASTED_ZIP_COMPLETION_TEXT,
  PASTED_ZIP_FILENAME,
  PLUGIN_CREATOR_COMPLETION_TEXT,
  PLUGIN_CREATOR_PROMPT,
  PLUGIN_REFINEMENT_COMPLETION_TEXT,
  PLUGIN_REFINEMENT_PROMPT,
  PROVIDER_SWITCH_COMPLETION,
  PROVIDER_SWITCH_FAILURE,
  PROVIDER_SWITCH_LUNA_MODEL_ID,
  PROVIDER_SWITCH_OFFICIAL_LABEL,
  PROVIDER_SWITCH_OFFICIAL_MODEL_ID,
  PROVIDER_SWITCH_OFFICIAL_MODEL_LABEL,
  PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
  PROVIDER_SWITCH_PROMPT,
  PROVIDER_SWITCH_RESUME_COMPLETION,
  PROVIDER_SWITCH_RESUME_PROMPT,
  QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
  QUALIFIED_SKILL_MENTION_PROMPT,
  QUEUE_CLEAR_INITIAL,
  QUEUE_CLEAR_MANUAL,
  QUEUE_DIRECT_FIRST,
  QUEUE_DIRECT_INITIAL,
  QUEUE_DIRECT_SECOND,
  QUEUE_DIRECT_THIRD,
  QUEUE_MANAGEMENT_COMPLETION_PREFIX,
  QUEUE_PRESERVE_INITIAL,
  QUEUE_PRESERVE_MANUAL,
  QUEUE_PRESERVE_QUEUED,
  RATE_LIMIT_COMPLETION_TEXT,
  RATE_LIMIT_PROMPT,
  RECONNECT_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  RETRY_COMPLETION_TEXT,
  RETRY_CONTINUATION_PROMPT,
  RETRY_FAILURE_TEXT,
  RETRY_PROMPT,
  RUNNING_FORK_COMPLETION_TEXT,
  RUNNING_FORK_FOLLOW_UP_PROMPT,
  SEND_REJECTION_COMPLETION_TEXT,
  SEND_REJECTION_RUNNING_PROMPT,
  SIDE_CHAT_COMPLETION_TEXT,
  SIDE_CHAT_FILENAME,
  SIDE_CHAT_GUIDANCE_COMPLETION,
  SIDE_CHAT_GUIDANCE_FOLLOW_UP,
  SIDE_CHAT_GUIDANCE_INITIAL,
  SIDE_CHAT_PROMPT,
  SUPERVISOR_COMPLETION_TEXT,
  SUPERVISOR_CORRECTION,
  SUPERVISOR_CORRECTION_COMPLETION_TEXT,
  SUPERVISOR_PROMPT,
  TASK_PLAN_PROMPT,
  TASK_PLAN_STEP,
  TASK_PROMPT,
  TELEMETRY_CAPTURE_PATH,
  TOOL_BLOCK_ORDER_COMPLETION_TEXT,
  TOOL_BLOCK_ORDER_PROMPT,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  VIEW_IMAGE_COMPLETION_TEXT,
  VIEW_IMAGE_PROMPT,
  VISION_SIDECAR_COMPLETION_TEXT,
  VISION_SIDECAR_DESCRIPTION,
  VISION_SIDECAR_MAIN_REQUEST_SCENARIO,
  VISION_SIDECAR_PROMPT,
  MULTIMODAL_VISION_COMPLETION_TEXT,
  MULTIMODAL_VISION_PROMPT,
  WINDOW_LIFECYCLE_COMPLETION_RESPONSE,
  WINDOW_LIFECYCLE_PROMPT,
  assert,
  createServer,
  join,
  pathToFileURL,
  randomUUID,
  withTimeout,
} from './shared.mjs'

const DESKTOP_CONTROL_COMMAND_INTERVAL_MS = 250
const CLOUD_STORED_USER_NAME = 'wework-desktop-e2e-cloud-user'
const CLOUD_AUTHENTICATED_USER_NAME = 'admin'
const CLOUD_RUNTIME_IDENTITY_TOOL_CALL_ID = 'wework-cloud-e2e-identity-tool-call'
const PLUGIN_WORKSPACE_PUBLISH_CALL_ID = 'wework-plugin-workspace-publish'
const PLUGIN_WORKSPACE_PUBLISH_COMMAND_PREFIX = 'Run this exact command: '
const PLUGIN_WORKSPACE_RESULT_MARKER = '[WEGENT_PLUGIN_RESULT]'
const EMBEDDED_BROWSER_SETUP_SEARCH_ID = 'wework-embedded-browser-setup-search'
const EMBEDDED_BROWSER_SETUP_OPEN_ID = 'wework-embedded-browser-setup-open'
const ELECTRON_OBSERVATION_ACTIONS = new Set([
  'activeElement',
  'getAttribute',
  'getElementCount',
  'getTerminalText',
  'getText',
  'metrics',
  'snapshot',
  'text',
  'waitFor',
])

function findNestedString(value, predicate) {
  if (typeof value === 'string') return predicate(value) ? value : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNestedString(item, predicate)
      if (match) return match
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const item of Object.values(value)) {
    const match = findNestedString(item, predicate)
    if (match) return match
  }
  return null
}

function requestContainsSkillLocator(body, skillPath, skillName) {
  const requestText = JSON.stringify(body)
  if (requestText.includes(skillPath)) return true

  const normalizedSkillPath = skillPath.replaceAll('\\', '/')
  const relativeSkillPath = `${skillName}/SKILL.md`
  const skillRoot = normalizedSkillPath.slice(0, -relativeSkillPath.length).replace(/\/$/u, '')
  const catalog = findNestedString(
    body,
    value => value.includes('### Skill roots') && value.includes(relativeSkillPath)
  )
  if (!catalog) return false

  for (const line of catalog.split(/\r?\n/u)) {
    const rootMatch = line.match(/^- `([^`]+)` = `([^`]+)`$/u)
    if (!rootMatch) continue
    const [, alias, root] = rootMatch
    if (
      root.replaceAll('\\', '/') === skillRoot &&
      catalog.includes(`(file: ${alias}/${relativeSkillPath})`)
    ) {
      return true
    }
  }
  return false
}

function toolOutputText(request, callId) {
  const findOutput = value => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const output = findOutput(item)
        if (output != null) return output
      }
      return null
    }
    if (!value || typeof value !== 'object') return null
    if (
      (value.type === 'function_call_output' || value.type === 'custom_tool_call_output') &&
      value.call_id === callId
    ) {
      return typeof value.output === 'string' ? value.output : JSON.stringify(value.output)
    }
    for (const item of Object.values(value)) {
      const output = findOutput(item)
      if (output != null) return output
    }
    return null
  }
  return findOutput(request.input ?? [])
}

function pluginWorkspacePublishCommand(body) {
  const context = findNestedString(body, value =>
    value.includes(PLUGIN_WORKSPACE_PUBLISH_COMMAND_PREFIX)
  )
  if (!context) return null
  const commandLine = context
    .split(/\r?\n/u)
    .find(line => line.startsWith(PLUGIN_WORKSPACE_PUBLISH_COMMAND_PREFIX))
  return commandLine?.slice(PLUGIN_WORKSPACE_PUBLISH_COMMAND_PREFIX.length) ?? null
}

function publishedPluginWorkspaceResult(body) {
  const completedStatus = /"status":"(?:published|pending_review)"/u
  const output = findNestedString(
    body,
    value => value.includes(PLUGIN_WORKSPACE_RESULT_MARKER) && completedStatus.test(value)
  )
  if (!output) return null
  const line = output
    .split(/\r?\n/u)
    .find(
      candidate =>
        candidate.includes(PLUGIN_WORKSPACE_RESULT_MARKER) && completedStatus.test(candidate)
    )
  if (!line) return null
  return line.slice(line.indexOf(PLUGIN_WORKSPACE_RESULT_MARKER))
}

function readyPluginWorkspaceResult(body) {
  const output = findNestedString(
    body,
    value => value.includes(PLUGIN_WORKSPACE_RESULT_MARKER) && value.includes('"status":"ready"')
  )
  if (!output) return null
  const line = output
    .split(/\r?\n/u)
    .find(
      candidate =>
        candidate.includes(PLUGIN_WORKSPACE_RESULT_MARKER) && candidate.includes('"status":"ready"')
    )
  if (!line) return null
  return line.slice(line.indexOf(PLUGIN_WORKSPACE_RESULT_MARKER))
}

class DesktopE2EServer {
  constructor(
    workspacePath,
    cloudWorkspacePath = workspacePath,
    desktopScenario = null,
    { enableMarketplaceConnectorAppsStub = false } = {}
  ) {
    this.workspacePath = workspacePath
    this.cloudWorkspacePath = cloudWorkspacePath
    this.desktopScenario = desktopScenario
    this.enableMarketplaceConnectorAppsStub = enableMarketplaceConnectorAppsStub
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => this.fail(error, response))
    })
    this.desktopScenario?.attachServer?.(this.server)
    this.controlServer = createServer((request, response) => {
      void this.handleControl(request, response).catch(error => this.fail(error, response))
    })
    this.fatalError = null
    this.fatalErrorPromise = new Promise((_, reject) => {
      this.rejectFatalError = reject
    })
    // A guarded operation observes this rejection; this handler prevents Node from
    // reporting it as unhandled in the small window before that operation starts.
    void this.fatalErrorPromise.catch(() => {})
    this.ready = null
    this.readyResolver = null
    this.readyCount = 0
    this.activeControlClientId = null
    this.controlClientsByWindow = new Map()
    this.controlWindowsByClient = new Map()
    this.controlCommandAvailableAt = new Map()
    this.readyWaiters = []
    this.commandQueue = []
    this.commandResults = new Map()
    this.commandHistory = []
    this.controlLongPolls = new Map()
    this.modelRequests = []
    this.catalogRequests = []
    this.httpRequests = []
    this.runtimeImBindingRequests = []
    this.telemetryRequests = []
    this.blockedCloudRequests = []
    this.blockedCloudResponses = new Set()
    this.blockedCloudWaiters = []
    this.failCloudModels = false
    this.cloudModelsAvailable = false
    this.failedCloudModelRequests = 0
    this.failedCloudModelWaiter = null
    this.sitesPluginInstalled = false
    this.sitesPluginDeviceId = null
    this.miniProgramPluginInstalled = false
    this.miniProgramPluginDeviceId = null
    this.sitesConnectionBootstrapRequests = 0
    this.scenario = 'initial'
    this.modelStage = 'initial'
    this.viewImageStage = 'initial'
    this.memoryStage = 'initial'
    this.concurrentMemoryResponses = []
    this.concurrentMemoryTaskNumbers = new Set()
    this.cloudModelStage = 'initial'
    this.matrixCase = null
    this.matrixState = null
    this.toolLessPrewarmHandled = false
    this.embeddedBrowserSetupToolLessPrewarmHandled = false
    this.viewImageToolLessPrewarmHandled = false
    this.memoryToolLessPrewarmHandled = false
    this.cloudToolLessPrewarmHandled = false
    this.officialPluginToolLessPrewarmHandled = false
    this.toolOutput = null
    this.initialToolRelease = new Promise(resolvePromise => {
      this.releaseInitialTool = resolvePromise
    })
    this.initialCompletionHeld = false
    this.initialCompletionRelease = new Promise(resolvePromise => {
      this.releaseInitialCompletion = resolvePromise
    })
    this.followUpRelease = new Promise(resolvePromise => {
      this.releaseFollowUp = resolvePromise
    })
    this.guidanceScrollStage = 'setup'
    this.guidanceScrollToolRelease = new Promise(resolvePromise => {
      this.releaseGuidanceScrollTool = resolvePromise
    })
    this.guidanceScrollCompletionRelease = new Promise(resolvePromise => {
      this.releaseGuidanceScrollResponse = resolvePromise
    })
    this.retryCompletionRelease = new Promise(resolvePromise => {
      this.releaseRetryCompletion = resolvePromise
    })
    this.requestUserInputRelease = new Promise(resolvePromise => {
      this.releaseRequestUserInput = resolvePromise
    })
    this.requestUserInputResponseWritten = new Promise(resolvePromise => {
      this.resolveRequestUserInputResponseWritten = resolvePromise
    })
    this.taskPlanCompletionRelease = new Promise(resolvePromise => {
      this.releaseTaskPlanCompletion = resolvePromise
    })
    this.taskPlanCompletionWritten = new Promise(resolvePromise => {
      this.resolveTaskPlanCompletionWritten = resolvePromise
    })
    this.cancellationCompletionRelease = new Promise(resolvePromise => {
      this.releaseCancellationCompletion = resolvePromise
    })
    this.sendRejectionCompletionRelease = new Promise(resolvePromise => {
      this.releaseSendRejectionCompletion = resolvePromise
    })
    this.queueManagementFirstCompletionRelease = new Promise(resolvePromise => {
      this.releaseQueueManagementFirstCompletion = resolvePromise
    })
    this.sideChatGuidanceRelease = new Promise(resolvePromise => {
      this.resolveSideChatGuidanceRelease = resolvePromise
    })
    this.reconnectDisconnectRelease = new Promise(resolvePromise => {
      this.releaseReconnectDisconnect = resolvePromise
    })
    this.reconnectResponseStarted = new Promise(resolvePromise => {
      this.resolveReconnectResponseStarted = resolvePromise
    })
    this.reconnectCompletionRelease = new Promise(resolvePromise => {
      this.releaseReconnectCompletion = resolvePromise
    })
    this.windowLifecycleRelease = new Promise(resolvePromise => {
      this.releaseWindowLifecycle = resolvePromise
    })
    this.windowLifecycleResponseStarted = new Promise(resolvePromise => {
      this.resolveWindowLifecycleResponseStarted = resolvePromise
    })
    this.backgroundCompletionRestoreRelease = new Promise(resolvePromise => {
      this.releaseBackgroundCompletionRestore = resolvePromise
    })
    this.backgroundCompletionRestoreResponseStarted = new Promise(resolvePromise => {
      this.resolveBackgroundCompletionRestoreResponseStarted = resolvePromise
    })
    this.backgroundFollowUpRestoreRelease = new Promise(resolvePromise => {
      this.releaseBackgroundFollowUpRestore = resolvePromise
    })
    this.backgroundFollowUpRestoreResponseStarted = new Promise(resolvePromise => {
      this.resolveBackgroundFollowUpRestoreResponseStarted = resolvePromise
    })
    this.runningForkFollowUpRelease = new Promise(resolvePromise => {
      this.releaseRunningForkFollowUp = resolvePromise
    })
    this.goalIdleInitialRelease = new Promise(resolvePromise => {
      this.releaseGoalIdleInitial = resolvePromise
    })
    this.goalIdleContinuationRelease = new Promise(resolvePromise => {
      this.releaseGoalIdleContinuation = resolvePromise
    })
    this.goalBusyPlanRelease = new Promise(resolvePromise => {
      this.releaseGoalBusyPlan = resolvePromise
    })
    this.goalRestartResumeRelease = new Promise(resolvePromise => {
      this.releaseGoalRestartResume = resolvePromise
    })
    this.supervisorInitialRelease = new Promise(resolvePromise => {
      this.releaseSupervisorInitial = resolvePromise
    })
    this.supervisorCorrectionStarted = new Promise(resolvePromise => {
      this.resolveSupervisorCorrectionStarted = resolvePromise
    })
    this.supervisorCorrectionRelease = new Promise(resolvePromise => {
      this.releaseSupervisorCorrection = resolvePromise
    })
    this.toolBlockNodeOutputObserved = new Promise(resolvePromise => {
      this.resolveToolBlockNodeOutputObserved = resolvePromise
    })
    this.toolBlockNodeRelease = new Promise(resolvePromise => {
      this.releaseToolBlockNode = resolvePromise
    })
    this.toolBlockGenericOutputObserved = new Promise(resolvePromise => {
      this.resolveToolBlockGenericOutputObserved = resolvePromise
    })
    this.toolBlockGenericRelease = new Promise(resolvePromise => {
      this.releaseToolBlockGeneric = resolvePromise
    })
    this.cloudInitialRelease = new Promise(resolvePromise => {
      this.releaseCloudInitial = resolvePromise
    })
    this.cloudFollowUpRelease = new Promise(resolvePromise => {
      this.releaseCloudFollowUp = resolvePromise
    })
    this.goalIdleStage = 'initial'
    this.goalBusyStage = 'plan'
    this.goalRestartStage = 'initial'
    this.cloudGoalRestartStage = 'initial'
    this.goalRestartResumeRequested = false
    this.automationStage = 'manual_goal'
    this.scenarioRequests = new Map()
    this.scenarioWaiters = new Map()
    this.heldScenarioResponses = new Map()
    this.localProtocolStates = new Map(
      LOCAL_MODEL_CASES.map(model => [model.protocol, { stage: 'initial', requests: [] }])
    )
    this.visionSidecarRequests = []
    this.multimodalVisionRequests = []
  }

  async start() {
    await Promise.all([
      this.listen(this.server, DESKTOP_MODEL_SERVER_PORT),
      this.listen(this.controlServer, DESKTOP_CONTROL_SERVER_PORT),
    ])
    const address = this.server.address()
    const controlAddress = this.controlServer.address()
    assert.ok(address && typeof address !== 'string', 'Desktop E2E server did not bind a TCP port')
    assert.ok(
      controlAddress && typeof controlAddress !== 'string',
      'Desktop E2E control server did not bind a TCP port'
    )
    this.url = `http://127.0.0.1:${address.port}`
    this.controlUrl = `http://127.0.0.1:${controlAddress.port}`
  }

  async listen(server, port) {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolvePromise()
      })
    })
  }

  async close() {
    for (const response of this.blockedCloudResponses) response.destroy()
    this.blockedCloudResponses.clear()
    for (const { response, timeout } of this.controlLongPolls.values()) {
      clearTimeout(timeout)
      response.destroy()
    }
    this.controlLongPolls.clear()
    this.desktopScenario?.close?.()
    this.server.closeAllConnections?.()
    this.controlServer.closeAllConnections?.()
    await Promise.all([
      new Promise(resolvePromise => this.server.close(resolvePromise)),
      new Promise(resolvePromise => this.controlServer.close(resolvePromise)),
    ])
  }

  awaitReady() {
    if (this.ready) return this.guard(Promise.resolve(this.ready))
    return this.guard(
      new Promise(resolvePromise => {
        this.readyResolver = resolvePromise
      })
    )
  }

  awaitReadyAfter(readyCount) {
    if (this.readyCount > readyCount) return this.guard(Promise.resolve(this.ready))
    return this.guard(
      new Promise(resolvePromise => {
        this.readyWaiters.push({ readyCount, resolve: resolvePromise })
      })
    )
  }

  awaitBlockedCloudRequest(pathname) {
    const request = this.blockedCloudRequests.find(item => item.pathname === pathname)
    if (request) return this.guard(Promise.resolve(request))
    return this.guard(
      new Promise(resolvePromise => {
        this.blockedCloudWaiters.push({ pathname, resolve: resolvePromise })
      })
    )
  }

  async awaitTelemetryEvent(eventName, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const request = this.telemetryRequests.find(candidate =>
        telemetryEvents(candidate.payload).some(event => event.event === eventName)
      )
      if (request) return request
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error(`The desktop app did not send the ${eventName} telemetry event`)
  }

  telemetryRequestCount() {
    return this.telemetryRequests.length
  }

  recordTelemetryRequest(request) {
    this.telemetryRequests.push(request)
  }

  fail(error, response) {
    if (!response.headersSent) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    } else if (!response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined)
    }
    if (this.fatalError) return
    this.fatalError = error instanceof Error ? error : new Error(String(error))
    this.rejectFatalError(this.fatalError)
    for (const pending of this.commandResults.values()) pending.reject(this.fatalError)
    this.commandResults.clear()
  }

  guard(promise) {
    if (this.fatalError) return Promise.reject(this.fatalError)
    return Promise.race([promise, this.fatalErrorPromise])
  }

  blockCloudRequest(request, response, url) {
    const blockedRequest = {
      method: request.method,
      pathname: url.pathname,
      search: url.search,
    }
    this.blockedCloudRequests.push(blockedRequest)
    this.blockedCloudResponses.add(response)
    response.once('close', () => this.blockedCloudResponses.delete(response))

    const remainingWaiters = []
    for (const waiter of this.blockedCloudWaiters) {
      if (waiter.pathname === url.pathname) {
        waiter.resolve(blockedRequest)
      } else {
        remainingWaiters.push(waiter)
      }
    }
    this.blockedCloudWaiters = remainingWaiters
  }

  failBlockedCloudModels() {
    this.failCloudModels = true
    const failedRequests = this.blockedCloudResponses.size
    for (const response of this.blockedCloudResponses) {
      json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
    }
    this.blockedCloudResponses.clear()
    this.failedCloudModelRequests += failedRequests
    if (failedRequests > 0) {
      this.failedCloudModelWaiter?.()
      this.failedCloudModelWaiter = null
    }
  }

  restoreCloudModels() {
    this.failCloudModels = false
    this.cloudModelsAvailable = true
  }

  awaitFailedCloudModelRequest() {
    if (this.failedCloudModelRequests > 0) return this.guard(Promise.resolve())
    return this.guard(
      new Promise(resolvePromise => {
        this.failedCloudModelWaiter = resolvePromise
      })
    )
  }

  setScenario(scenario) {
    assert.ok(
      [
        'initial',
        'embedded_browser_setup',
        'follow_up',
        'running_fork_follow_up',
        'fork_follow_up',
        'task_plan',
        'request_user_input',
        'mcp_elicitation',
        'window_lifecycle',
        'background_completion_restore',
        'background_follow_up_restore',
        'goal_idle',
        'goal_busy_handoff',
        'goal_restart',
        'cloud_goal_restart',
        'turn_navigation',
        'cancellation',
        'send_rejection',
        'guidance_scroll',
        'queue_management',
        'retry',
        'rate_limit',
        'anthropic_empty_response',
        'reconnect',
        'checkpoint_task',
        'worktree_queue_hold',
        'worktree_restart_hold',
        'message_edit',
        'file_panel_anchor',
        'fresh_chat',
        'attachment_only',
        'pasted_zip_attachment',
        'pasted_workspace_paths',
        'dropped_workspace_paths',
        'workspace_selection_streaming',
        'memory',
        'concurrent_memory',
        'side_chat_attachment',
        'side_chat_guidance',
        'cloud_initial',
        'cloud_follow_up',
        'model_protocol_matrix',
        'provider_switch_retry',
        'vision_sidecar',
        'multimodal_vision',
        'view_image',
        'local_markdown_image',
        'tool_block_order',
        'official_plugin',
        'automation',
        'skill_mention_display',
        'connector_auth_unmatched_resume',
        'supervisor',
      ].includes(scenario),
      `Unknown desktop E2E scenario: ${scenario}`
    )
    this.scenario = scenario
  }

  holdScenarioResponse(scenario) {
    assert.ok(
      ['worktree_queue_hold', 'worktree_restart_hold'].includes(scenario),
      `Scenario "${scenario}" does not support held responses`
    )
    let release
    const promise = new Promise(resolvePromise => {
      release = resolvePromise
    })
    this.heldScenarioResponses.set(scenario, { promise, release })
  }

  releaseScenarioResponse(scenario) {
    const held = this.heldScenarioResponses.get(scenario)
    held?.release()
    this.heldScenarioResponses.delete(scenario)
  }

  setMatrixCase(model) {
    this.matrixCase = model
    this.matrixState = {
      stage: 'text',
      requests: [],
    }
    this.setScenario('model_protocol_matrix')
  }

  recordScenarioRequest(scenario, request) {
    const requests = this.scenarioRequests.get(scenario) ?? []
    requests.push(request)
    this.scenarioRequests.set(scenario, requests)
    const waiter = this.scenarioWaiters.get(scenario)
    if (waiter) {
      this.scenarioWaiters.delete(scenario)
      waiter(request)
    }
  }

  awaitScenarioRequest(scenario) {
    const request = this.scenarioRequests.get(scenario)?.at(-1)
    if (request) return this.guard(Promise.resolve(request))
    return this.guard(
      new Promise(resolvePromise => {
        this.scenarioWaiters.set(scenario, resolvePromise)
      })
    )
  }

  async awaitScenarioRequestCount(scenario, count, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
    const waitForCount = (async () => {
      while ((this.scenarioRequests.get(scenario)?.length ?? 0) < count) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      return this.scenarioRequests.get(scenario).at(-1)
    })()
    return withTimeout(
      this.guard(waitForCount),
      timeoutMs,
      `Timed out waiting for ${count} ${scenario} scenario requests`
    )
  }

  releaseInitialToolExecution() {
    this.releaseInitialTool()
  }

  holdInitialCompletionResponse() {
    this.initialCompletionHeld = true
  }

  releaseInitialCompletionResponse() {
    this.releaseInitialCompletion()
  }

  releaseFollowUpResponse() {
    this.releaseFollowUp()
  }

  releaseGuidanceScrollToolExecution() {
    this.releaseGuidanceScrollTool()
  }

  releaseGuidanceScrollCompletion() {
    this.releaseGuidanceScrollResponse()
  }

  releaseRetryResponse() {
    this.releaseRetryCompletion()
  }

  releaseRequestUserInputResponse() {
    this.releaseRequestUserInput()
    return this.guard(this.requestUserInputResponseWritten)
  }

  releaseTaskPlanResponse() {
    this.releaseTaskPlanCompletion()
    return this.guard(this.taskPlanCompletionWritten)
  }

  releaseCancellationResponse() {
    this.releaseCancellationCompletion()
  }

  releaseSendRejectionResponse() {
    this.releaseSendRejectionCompletion()
  }

  releaseQueueManagementFirstResponse() {
    this.releaseQueueManagementFirstCompletion()
  }

  releaseSideChatGuidanceResponse() {
    this.resolveSideChatGuidanceRelease()
  }

  awaitReconnectResponseStarted() {
    return this.guard(this.reconnectResponseStarted)
  }

  disconnectReconnectResponse() {
    this.releaseReconnectDisconnect()
  }

  releaseReconnectResponse() {
    this.releaseReconnectCompletion()
  }

  awaitWindowLifecycleResponseStarted() {
    return this.guard(this.windowLifecycleResponseStarted)
  }

  releaseWindowLifecycleResponse() {
    this.releaseWindowLifecycle()
  }

  awaitBackgroundCompletionRestoreResponseStarted() {
    return this.guard(this.backgroundCompletionRestoreResponseStarted)
  }

  releaseBackgroundCompletionRestoreResponse() {
    this.releaseBackgroundCompletionRestore()
  }

  awaitBackgroundFollowUpRestoreResponseStarted() {
    return this.guard(this.backgroundFollowUpRestoreResponseStarted)
  }

  releaseBackgroundFollowUpRestoreResponse() {
    this.releaseBackgroundFollowUpRestore()
  }

  releaseRunningForkFollowUpResponse() {
    this.releaseRunningForkFollowUp()
  }

  releaseSupervisorInitialResponse() {
    this.releaseSupervisorInitial()
  }

  awaitSupervisorCorrectionResponseStarted() {
    return this.guard(this.supervisorCorrectionStarted)
  }

  releaseSupervisorCorrectionResponse() {
    this.releaseSupervisorCorrection()
  }

  releaseGoalIdleInitialResponse() {
    this.releaseGoalIdleInitial()
  }

  releaseGoalIdleResponse() {
    this.releaseGoalIdleContinuation()
  }

  releaseGoalBusyPlanResponse() {
    this.releaseGoalBusyPlan()
  }

  releaseGoalRestartResponse() {
    this.releaseGoalRestartResume()
  }

  markGoalRestartResumeRequested() {
    this.goalRestartResumeRequested = true
  }

  releaseCloudInitialResponse() {
    this.releaseCloudInitial()
  }

  releaseCloudFollowUpResponse() {
    this.releaseCloudFollowUp()
  }

  releaseConcurrentMemoryResponses() {
    for (const { response, stream } of this.concurrentMemoryResponses.splice(0)) {
      response.end(createSse(stream.finish))
    }
  }

  async command(action, selector, options = {}) {
    assert.ok(this.activeControlClientId, 'No active desktop control client is registered')
    return this.commandForClient(this.activeControlClientId, action, selector, options)
  }

  activateWindow(windowLabel) {
    const clientId = this.controlClientsByWindow.get(windowLabel)
    assert.ok(clientId, `No desktop control client is registered for window ${windowLabel}`)
    this.activeControlClientId = clientId
  }

  async commandForWindow(windowLabel, action, selector, options = {}) {
    const clientId = this.controlClientsByWindow.get(windowLabel)
    assert.ok(clientId, `No desktop control client is registered for window ${windowLabel}`)
    return this.commandForClient(clientId, action, selector, options)
  }

  async commandForClient(clientId, action, selector, options = {}) {
    const observesElectronState = ELECTRON_OBSERVATION_ACTIONS.has(action)
    const availableAt = observesElectronState
      ? 0
      : (this.controlCommandAvailableAt.get(clientId) ?? 0)
    const delayMs = Math.max(0, availableAt - Date.now())
    if (delayMs > 0) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
    }
    assert.ok(
      this.controlWindowsByClient.has(clientId),
      `Desktop control client ${clientId} is not registered`
    )
    const id = randomUUID()
    const command = { id, action, selector, ...options }
    let resolveDelivery
    let rejectDelivery
    const delivery = new Promise((resolvePromise, reject) => {
      resolveDelivery = resolvePromise
      rejectDelivery = reject
    })
    const result = new Promise((resolvePromise, reject) => {
      this.commandResults.set(id, {
        clientId,
        resolve: resolvePromise,
        reject,
        resolveDelivery,
        started: false,
      })
    })
    this.commandQueue.push({ clientId, command, rejectDelivery })
    this.deliverPendingControlCommand(clientId)
    try {
      await withTimeout(
        this.guard(Promise.race([delivery, result])),
        DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS,
        `Timed out delivering UI action ${action} for ${selector}`
      )
      return await withTimeout(
        this.guard(result),
        (options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS) + DESKTOP_CONTROL_RESULT_GRACE_MS,
        `Timed out running UI action ${action} for ${selector}`
      )
    } catch (error) {
      this.commandQueue = this.commandQueue.filter(item => item.command.id !== id)
      this.commandResults.delete(id)
      throw error
    }
  }

  deliverQueuedControlCommand(clientId, response) {
    const commandIndex = this.commandQueue.findIndex(item => item.clientId === clientId)
    if (commandIndex < 0) return false

    const { command } = this.commandQueue[commandIndex]
    this.commandHistory.push({
      ...command,
      clientId,
      deliveredAt: new Date().toISOString(),
    })
    json(response, 200, command)
    return true
  }

  deliverPendingControlCommand(clientId) {
    const pending = this.controlLongPolls.get(clientId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.controlLongPolls.delete(clientId)
    return this.deliverQueuedControlCommand(clientId, pending.response)
  }

  waitForQueuedControlCommand(clientId, response) {
    const previous = this.controlLongPolls.get(clientId)
    if (previous) {
      clearTimeout(previous.timeout)
      previous.response.writeHead(204)
      previous.response.end()
    }
    const timeout = setTimeout(() => {
      if (this.controlLongPolls.get(clientId)?.response !== response) return
      this.controlLongPolls.delete(clientId)
      response.writeHead(204)
      response.end()
    }, 25_000)
    this.controlLongPolls.set(clientId, { response, timeout })
    response.once('close', () => {
      if (this.controlLongPolls.get(clientId)?.response !== response) return
      clearTimeout(timeout)
      this.controlLongPolls.delete(clientId)
    })
  }

  async handleControl(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.controlUrl)
    if (await this.handleControlRoute(request, response, url)) return
    json(response, 404, {
      error: `No Desktop E2E control route for ${request.method} ${url.pathname}`,
    })
  }

  async handle(request, response) {
    cors(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', this.url)
    this.httpRequests.push({
      method: request.method ?? 'UNKNOWN',
      pathname: url.pathname,
    })
    if (await this.handleControlRoute(request, response, url)) return
    if (await this.desktopScenario?.handleHttp?.(request, response, url)) return

    if (request.method === 'POST' && url.pathname === TELEMETRY_CAPTURE_PATH) {
      const rawBody = await readRawRequestBody(request)
      this.recordTelemetryRequest({
        contentType: request.headers['content-type'] ?? null,
        payload: parseTelemetryPayload(rawBody),
        rawBody,
      })
      json(response, 200, { status: 1 })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/users/me') {
      json(response, 200, {
        id: 9001,
        user_name: CLOUD_STORED_USER_NAME,
        email: 'desktop-e2e@wework.local',
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/apps/installed') {
      json(response, 200, { apps: [] })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/im/private-sessions') {
      json(response, 200, {
        total: 1,
        items: [
          {
            session_key: 'desktop-e2e-im-session',
            channel_type: 'dingtalk',
            channel_label: 'DingTalk',
            channel_id: 77,
            conversation_id: 'desktop-e2e-conversation',
            sender_id: 'desktop-e2e-user',
            display_name: 'Desktop E2E',
            mode: 'task',
            state: 'idle',
            active_task_id: null,
            last_seen_at: '2026-08-12T00:00:00.000Z',
          },
        ],
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/runtime-work/im-sessions') {
      const body = await readRequestBody(request)
      this.runtimeImBindingRequests.push(body)
      json(response, 200, {
        address: body.address,
        boundSessionKeys: body.sessionKeys,
        notifiedCount: 1,
      })
      return
    }

    // Official/local marketplace plugins may infer on_install connectors from
    // .app.json entries (e.g. openai-platform). ensureMarketplaceConnectors
    // lists Wegent connector-apps before plugin/install; stub them as already
    // connected so desktop E2E can exercise the real install path.
    if (
      this.enableMarketplaceConnectorAppsStub &&
      request.method === 'GET' &&
      url.pathname === '/api/connector-apps'
    ) {
      const connected = status => ({
        status,
        external_account_name: status === 'connected' ? 'desktop-e2e' : null,
        granted_scopes: status === 'connected' ? ['e2e'] : [],
        expires_at: null,
      })
      json(response, 200, [
        {
          id: 1,
          slug: 'openai-platform',
          name: 'OpenAI Platform',
          description: 'Desktop E2E stub for OpenAI Developers app connectors',
          icon_url: null,
          auth_type: 'oauth2',
          connection: connected('connected'),
        },
        {
          id: 2,
          slug: 'openai-developers',
          name: 'OpenAI Developers',
          description: 'Desktop E2E stub matching inferred plugin-name connectors',
          icon_url: null,
          auth_type: 'oauth2',
          connection: connected('connected'),
        },
        {
          id: 3,
          slug: 'github',
          name: 'GitHub',
          description: 'Desktop E2E stub for cloud connector authorization flows',
          icon_url: null,
          auth_type: 'oauth2',
          connection: connected('connected'),
        },
      ])
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/users/me/wegent-runtime-token') {
      assert.equal(
        request.headers.authorization,
        'Bearer wework-desktop-e2e-cloud-token',
        'The runtime token request did not use the cloud authentication token'
      )
      json(response, 200, {
        auth_token: 'wework-desktop-e2e-runtime-token',
        token_type: 'bearer',
        expires_in: 3600,
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/sites/app-types') {
      json(response, 200, {
        items: [
          {
            app_type: 'web',
            enabled: true,
            order: 10,
            capabilities: ['create', 'publish', 'edit', 'delete'],
            create: {
              plugin_name: 'wegent-sites',
              marketplace_name: 'wegent',
            },
          },
          {
            app_type: 'miniapp',
            enabled: true,
            order: 20,
            capabilities: ['create', 'open_experience'],
            create: {
              plugin_name: 'weibo-miniapp-h5-develop-agent',
              marketplace_name: 'wegent',
            },
          },
        ],
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/sites') {
      const appType = url.searchParams.get('app_type') || 'web'
      const query = url.searchParams.get('q')?.trim().toLowerCase() || ''
      const items =
        appType === 'miniapp'
          ? [
              {
                app_type: 'miniapp',
                siteid: 'prj_e2e_mini',
                taskid: 'prj_e2e_mini',
                username: 'wework-desktop-e2e-cloud-user',
                name: 'E2E Mini Program',
                slug: 'prj_e2e_mini',
                app_id: 'wx-e2e-mini',
                status: 'experience',
                version: '1.0.0',
                experience_url: 'https://example.test/mini-experience',
                thumbnail_url: null,
                created_at: '2026-07-22T00:10:00Z',
                updated_at: '2026-07-22T00:12:00Z',
              },
            ]
          : [
              {
                app_type: 'web',
                siteid: 'prj_e2e_product',
                taskid: 'prj_e2e_product',
                username: 'wework-desktop-e2e-cloud-user',
                name: 'E2E Product Site',
                slug: 'prj_e2e_product',
                internal_url: 'https://sites.internal/e2e-product',
                external_url: null,
                publish_status: 'unpublished',
                last_publish_error: null,
                thumbnail_url: null,
                created_at: '2026-07-22T00:00:00Z',
                updated_at: '2026-07-22T00:00:00Z',
                published_at: null,
              },
            ]
      const filteredItems = query
        ? items.filter(item => item.name.toLowerCase().includes(query))
        : items
      json(response, 200, {
        items: filteredItems,
        total: filteredItems.length,
        offset: Number.parseInt(url.searchParams.get('offset') || '0', 10),
        limit: Number.parseInt(url.searchParams.get('limit') || '20', 10),
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/plugins/installed') {
      json(response, 200, {
        items: [
          ...(this.sitesPluginInstalled
            ? [installedSitesPlugin(this.sitesPluginDeviceId ?? 'local-device')]
            : []),
          ...(this.miniProgramPluginInstalled
            ? [installedMiniProgramPlugin(this.miniProgramPluginDeviceId ?? 'local-device')]
            : []),
        ],
      })
      return
    }

    const builtinPluginMatch = url.pathname.match(
      /^\/api\/plugins\/builtin\/(wegent-sites|weibo-miniapp-h5-develop-agent)\/ensure-installed$/
    )
    if (request.method === 'POST' && builtinPluginMatch) {
      const body = await readRequestBody(request)
      const pluginName = builtinPluginMatch[1]
      const isSitesPlugin = pluginName === 'wegent-sites'
      const targetDeviceId =
        typeof body.device_id === 'string' && body.device_id.trim() ? body.device_id.trim() : null
      const installedPlugin = isSitesPlugin
        ? installedSitesPlugin(targetDeviceId ?? 'local-device')
        : installedMiniProgramPlugin(targetDeviceId ?? 'local-device')
      const installedPluginId = isSitesPlugin ? 601 : 602
      if (isSitesPlugin) {
        this.sitesPluginInstalled = true
        this.sitesPluginDeviceId = targetDeviceId
      } else {
        this.miniProgramPluginInstalled = true
        this.miniProgramPluginDeviceId = targetDeviceId
      }
      if (!targetDeviceId) {
        if (isSitesPlugin) {
          this.sitesConnectionBootstrapRequests += 1
        }
        json(response, 200, {
          plugin: installedPlugin,
          sync: null,
        })
        return
      }
      json(response, 200, {
        plugin: installedPlugin,
        sync: {
          success: true,
          device_id: targetDeviceId,
          mode: 'merge',
          skills: [],
          plugins: [{ id: installedPluginId, name: pluginName, status: 'synced' }],
          mcps: [],
          errors: [],
          synced: 1,
          failed: 0,
          skipped: 0,
          results: [
            {
              device_id: targetDeviceId,
              success: true,
              error: null,
              skills: [],
              plugins: [{ id: installedPluginId, name: pluginName, status: 'synced' }],
              mcps: [],
              errors: [],
            },
          ],
        },
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/plugins/marketplace') {
      json(response, 200, {
        items: [
          sitesMarketplacePlugin(this.sitesPluginInstalled),
          miniProgramMarketplacePlugin(this.miniProgramPluginInstalled),
        ],
      })
      return
    }

    if (request.method === 'GET' && url.pathname === BLOCKED_CLOUD_MODEL_PATH) {
      if (this.cloudModelsAvailable) {
        json(response, 200, {
          data: [
            {
              name: `codex-${DEFAULT_MODEL_ID}`,
              type: 'runtime',
              displayName: `${DEFAULT_MODEL_LABEL} (Codex)`,
              provider: 'openai',
              modelId: DEFAULT_MODEL_ID,
              namespace: 'default',
              config: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                weworkModelKind: 'codex-official',
                ui: { family: 'codex-official', modelLabel: DEFAULT_MODEL_LABEL },
              },
              runtime: { family: 'openai.openai-responses' },
              isActive: true,
            },
            {
              name: PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
              type: 'runtime',
              displayName: PROVIDER_SWITCH_OFFICIAL_LABEL,
              provider: 'openai',
              modelId: PROVIDER_SWITCH_OFFICIAL_MODEL_ID,
              namespace: 'default',
              config: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                weworkModelKind: 'codex-official',
                ui: { family: 'codex-official', modelLabel: PROVIDER_SWITCH_OFFICIAL_MODEL_LABEL },
              },
              runtime: { family: 'openai.openai-responses' },
              isActive: true,
            },
            {
              name: CLOUD_PUBLIC_MODEL_NAME,
              type: 'public',
              displayName: CLOUD_PUBLIC_MODEL_LABEL,
              provider: 'openai',
              modelId: 'desktop-e2e-public-upstream-model',
              namespace: 'default',
              resourceUserId: 0,
              config: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                ui: { family: 'gpt', modelLabel: CLOUD_PUBLIC_MODEL_LABEL },
              },
              runtime: { family: 'openai.openai-responses' },
              isActive: true,
            },
          ],
        })
        return
      }
      if (this.failCloudModels) {
        this.failedCloudModelRequests += 1
        this.failedCloudModelWaiter?.()
        this.failedCloudModelWaiter = null
        json(response, 503, { error: 'Desktop E2E intentional cloud model failure' })
        return
      }
      this.blockCloudRequest(request, response, url)
      return
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/api/model-runtime/responses' &&
      this.scenario === 'supervisor'
    ) {
      const body = await readRequestBody(request)
      const requestText = JSON.stringify(body)
      assert.equal(
        request.headers.authorization,
        'Bearer wework-desktop-e2e-cloud-token',
        'The supervisor model API request did not use the cloud authentication token'
      )
      assert.deepEqual(
        body.model_ref,
        {
          name: CLOUD_PUBLIC_MODEL_NAME,
          type: 'public',
          namespace: 'default',
          resource_user_id: 0,
        },
        'The supervisor model API request did not preserve the selected cloud model identity'
      )
      assert.equal(
        body.metadata?.source,
        'wework-supervisor',
        'The supervisor model API request did not identify its source'
      )
      assert.ok(
        requestText.includes('correction'),
        'The supervisor evaluator request did not include its structured output schema'
      )
      assert.ok(
        requestText.includes(SUPERVISOR_COMPLETION_TEXT),
        'The supervisor evaluator did not receive the latest assistant progress'
      )
      assert.equal(
        requestText.includes(SUPERVISOR_PROMPT),
        false,
        'The supervisor evaluator received the original user transcript instead of recent AI content'
      )
      this.recordScenarioRequest('supervisor', {
        body,
        headers: request.headers,
        pathname: url.pathname,
      })
      json(response, 200, {
        output_text: JSON.stringify({
          correction: SUPERVISOR_CORRECTION,
          rationale: 'The completed reply should restate the original constraint.',
        }),
        model: CLOUD_PUBLIC_MODEL_NAME,
        created_at: '2026-08-12T00:00:00Z',
      })
      return
    }

    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      this.catalogRequests.push({
        authorization: request.headers.authorization ?? null,
        ifNoneMatch: request.headers['if-none-match'] ?? null,
        pathname: url.pathname,
        search: url.search,
      })
      assert.equal(
        request.headers.authorization,
        `Bearer ${MODEL_API_KEY}`,
        'The local catalog router did not forward the configured model API key'
      )
      response.setHeader('ETag', '"wework-desktop-e2e-models-v1"')
      json(response, 200, {
        models: [],
      })
      return
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/login/oidc')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(
        '<!doctype html><html><body style="margin:0;font:16px system-ui;background:#fff;color:#222">' +
          '<main style="display:grid;min-height:100vh;place-items:center">' +
          '<section style="text-align:center"><h1>智能体工作台</h1>' +
          '<p style="color:#6b7280">Desktop E2E Agent fixture</p></section>' +
          '</main></body></html>'
      )
      return
    }

    const cloudResponsesProxy = url.pathname === '/api/runtime-work/llm-responses-proxy/responses'
    const modelProtocol =
      url.pathname === '/v1/responses' || url.pathname === '/responses' || cloudResponsesProxy
        ? 'responses'
        : url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions'
          ? 'chat'
          : url.pathname === '/v1/messages' || url.pathname === '/messages'
            ? 'anthropic'
            : null
    if (request.method === 'POST' && modelProtocol) {
      if (cloudResponsesProxy) {
        assert.equal(
          request.headers['x-wegent-model-type'],
          'public',
          'The automation cloud model type was not forwarded to the Backend proxy'
        )
        assert.equal(
          request.headers['x-wegent-model-namespace'],
          'default',
          'The automation cloud model namespace was not forwarded to the Backend proxy'
        )
        assert.equal(
          request.headers['x-wegent-model-user-id'],
          '0',
          'The automation cloud model owner was not forwarded to the Backend proxy'
        )
      }
      await this.handleModelResponse(request, response, modelProtocol, {
        acceptedAuthorization: cloudResponsesProxy
          ? 'Bearer wework-desktop-e2e-cloud-token'
          : undefined,
      })
      return
    }

    json(response, 404, { error: `No Desktop E2E route for ${request.method} ${url.pathname}` })
  }

  async handleControlRoute(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/ready') {
      const ready = await readRequestBody(request)
      assert.equal(typeof ready.clientId, 'string', 'Desktop control client ID is required')
      assert.ok(ready.clientId.length > 0, 'Desktop control client ID cannot be empty')
      assert.equal(typeof ready.windowLabel, 'string', 'Desktop control window label is required')
      assert.ok(ready.windowLabel.length > 0, 'Desktop control window label cannot be empty')
      const previousClientId = this.controlClientsByWindow.get(ready.windowLabel)
      this.activeControlClientId = ready.clientId
      this.controlClientsByWindow.set(ready.windowLabel, ready.clientId)
      this.controlWindowsByClient.set(ready.clientId, ready.windowLabel)
      if (previousClientId && previousClientId !== ready.clientId) {
        const previousLongPoll = this.controlLongPolls.get(previousClientId)
        if (previousLongPoll) {
          clearTimeout(previousLongPoll.timeout)
          previousLongPoll.response.destroy()
          this.controlLongPolls.delete(previousClientId)
        }
        this.controlWindowsByClient.delete(previousClientId)
        this.controlCommandAvailableAt.delete(previousClientId)
        const replacementError = new Error(
          `Desktop control client ${previousClientId} for ${ready.windowLabel} was replaced by ${ready.clientId}`
        )
        this.commandQueue = this.commandQueue.filter(item => {
          if (item.clientId !== previousClientId) return true
          item.rejectDelivery(replacementError)
          return false
        })
        for (const [id, pending] of this.commandResults) {
          if (pending.clientId !== previousClientId) continue
          this.commandResults.delete(id)
          pending.reject(replacementError)
        }
      }
      this.ready = ready
      this.readyCount += 1
      this.readyResolver?.(ready)
      this.readyResolver = null
      const remainingWaiters = []
      for (const waiter of this.readyWaiters) {
        if (this.readyCount > waiter.readyCount) {
          waiter.resolve(ready)
        } else {
          remainingWaiters.push(waiter)
        }
      }
      this.readyWaiters = remainingWaiters
      json(response, 200, { ok: true })
      return true
    }

    if (request.method === 'GET' && url.pathname === '/commands') {
      const clientId = url.searchParams.get('clientId')
      if (!clientId || !this.controlWindowsByClient.has(clientId)) {
        response.writeHead(204)
        response.end()
        return true
      }
      if (this.deliverQueuedControlCommand(clientId, response)) return true
      if (url.searchParams.get('wait') === '1') {
        this.waitForQueuedControlCommand(clientId, response)
        return true
      }
      response.writeHead(204)
      response.end()
      return true
    }

    if (request.method === 'GET' && url.pathname === '/control-tick') {
      setTimeout(() => {
        response.writeHead(204)
        response.end()
      }, 50)
      return true
    }

    if (request.method === 'POST' && url.pathname === '/started') {
      const started = await readRequestBody(request)
      const pending = this.commandResults.get(started.id)
      if (!pending) {
        json(response, 404, { error: `Unknown command ${started.id}` })
        return true
      }
      if (started.clientId !== pending.clientId) {
        json(response, 409, {
          error: `Command ${started.id} belongs to a different desktop control client`,
        })
        return true
      }
      if (!pending.started) {
        pending.started = true
        this.commandQueue = this.commandQueue.filter(item => item.command.id !== started.id)
        pending.resolveDelivery()
      }
      json(response, 200, { ok: true })
      return true
    }

    if (request.method === 'POST' && url.pathname === '/results') {
      const result = await readRequestBody(request)
      const pending = this.commandResults.get(result.id)
      if (!pending) {
        json(response, 404, { error: `Unknown command ${result.id}` })
        return true
      }
      const resultWindowLabel = this.controlWindowsByClient.get(result.clientId)
      if (
        result.clientId !== pending.clientId ||
        !resultWindowLabel ||
        this.controlClientsByWindow.get(resultWindowLabel) !== result.clientId
      ) {
        json(response, 409, {
          error: `Command ${result.id} belongs to a different desktop control client`,
        })
        return true
      }
      this.commandResults.delete(result.id)
      this.controlCommandAvailableAt.set(
        result.clientId,
        Date.now() + DESKTOP_CONTROL_COMMAND_INTERVAL_MS
      )
      if (result.ok) {
        pending.resolve(result.value ?? '')
      } else {
        pending.reject(new Error(result.error ?? `UI action ${result.id} failed`))
      }
      json(response, 200, { ok: true })
      return true
    }
    return false
  }

  async handleModelResponse(request, response, protocol, options = {}) {
    const body = await readRequestBody(request)
    const authorization = request.headers.authorization ?? null
    const modelRequest = { authorization, body, scenario: this.scenario }
    this.modelRequests.push(modelRequest)
    const authenticated =
      authorization === `Bearer ${MODEL_API_KEY}` ||
      authorization === options.acceptedAuthorization ||
      request.headers['x-api-key'] === MODEL_API_KEY
    if (!authenticated) {
      json(response, 401, { error: 'The Desktop E2E model API key was not forwarded by Codex' })
      return
    }

    if (this.scenario === 'model_protocol_matrix') {
      this.handleModelProtocolMatrixResponse(response, protocol, body, request.headers)
      return
    }

    if (this.scenario === 'provider_switch_retry') {
      this.handleProviderSwitchRetryResponse(response, protocol, body, modelRequest)
      return
    }

    if (this.scenario === 'vision_sidecar') {
      const serialized = JSON.stringify(body)
      const modelCase = [LOCAL_VISION_SIDECAR_CASE, CLOUD_VISION_SIDECAR_CASE].find(
        candidate => body.model === candidate.sidecarModelId || body.model === candidate.mainModelId
      )
      assert.ok(modelCase, `Unexpected vision sidecar model request: ${body.model}`)
      if (body.model === modelCase.sidecarModelId) {
        assert.equal(protocol, 'chat', 'The vision sidecar reached the wrong protocol endpoint')
        assert.equal(body.stream, false, 'The vision sidecar request must not stream')
        assert.ok(serialized.includes('image_url'), 'The vision sidecar did not receive the image')
        this.visionSidecarRequests.push({ kind: 'vision', body })
        json(response, 200, {
          id: 'desktop-e2e-vision-description',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: VISION_SIDECAR_DESCRIPTION },
              finish_reason: 'stop',
            },
          ],
        })
        return
      }
      if (body.model === modelCase.mainModelId) {
        assert.equal(protocol, 'responses', 'The vision primary model used the wrong protocol')
        if (codexRequestKind(body) === 'prewarm' || codexRequestKind(body) === 'compaction') {
          const responseId = `vision-sidecar-empty-${this.modelRequests.length}`
          this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
          return
        }
        assert.ok(
          serialized.includes(VISION_SIDECAR_PROMPT),
          'The vision primary model did not receive the user prompt'
        )
        assert.ok(
          serialized.includes(VISION_SIDECAR_DESCRIPTION),
          'The vision primary model did not receive the generated description'
        )
        assert.equal(
          serialized.includes('input_image'),
          false,
          'The original image leaked to the text-only primary model'
        )
        this.visionSidecarRequests.push({ kind: 'main', body })
        this.recordScenarioRequest(VISION_SIDECAR_MAIN_REQUEST_SCENARIO, modelRequest)
        const responseId = `vision-sidecar-main-${this.modelRequests.length}`
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(VISION_SIDECAR_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
    }

    if (this.scenario === 'multimodal_vision') {
      const serialized = JSON.stringify(body)
      assert.equal(
        body.model,
        CLOUD_MULTIMODAL_VISION_CASE.mainModelId,
        `Unexpected multimodal vision model request: ${body.model}`
      )
      assert.equal(protocol, 'responses', 'The multimodal model used the wrong protocol')
      if (codexRequestKind(body) === 'prewarm' || codexRequestKind(body) === 'compaction') {
        const responseId = `multimodal-vision-empty-${this.modelRequests.length}`
        this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
        return
      }
      assert.ok(
        serialized.includes(MULTIMODAL_VISION_PROMPT),
        'The multimodal model did not receive the user prompt'
      )
      assert.ok(
        serialized.includes('input_image'),
        'The multimodal model did not receive the image'
      )
      assert.equal(
        serialized.includes(VISION_SIDECAR_DESCRIPTION),
        false,
        'The multimodal model unexpectedly received a sidecar description'
      )
      this.multimodalVisionRequests.push(body)
      const responseId = `multimodal-vision-main-${this.modelRequests.length}`
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(MULTIMODAL_VISION_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    const localModel = localProtocolCase(body.model)
    if (localModel) {
      assert.equal(
        protocol,
        localModel.protocol,
        `Local model ${body.model} reached the wrong ${protocol} endpoint`
      )
      this.handleLocalProtocolResponse(response, localModel, body, request.headers)
      return
    }

    const responseId = `wework-e2e-response-${this.modelRequests.length}`
    const requestKind = codexRequestKind(body)
    if (requestKind === 'compaction') {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage('Desktop E2E context compaction completed.'),
        responseCompleted(responseId),
      ])
      return
    }

    if (requestKind === 'prewarm') {
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    const publishCommand = pluginWorkspacePublishCommand(body)
    if (requestContainsToolOutput(body, PLUGIN_WORKSPACE_PUBLISH_CALL_ID)) {
      const publishedResult = publishedPluginWorkspaceResult(body)
      assert.ok(
        publishedResult,
        'The Plugin Creator publish command did not return a result marker'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(publishedResult),
        responseCompleted(responseId),
      ])
      return
    }
    if (publishCommand) {
      const tool = selectShellToolCommand(body, publishCommand, this.cloudWorkspacePath)
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall(PLUGIN_WORKSPACE_PUBLISH_CALL_ID, tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      return
    }

    const readyResult = readyPluginWorkspaceResult(body)
    if (readyResult) {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(readyResult),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'connector_auth_unmatched_resume') {
      this.recordScenarioRequest('connector_auth_unmatched_resume', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT),
        'The unmatched connector auth resume scenario did not receive its trigger prompt'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (JSON.stringify(body).includes(PLUGIN_CREATOR_PROMPT)) {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PLUGIN_CREATOR_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (JSON.stringify(body).includes(PLUGIN_REFINEMENT_PROMPT)) {
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PLUGIN_REFINEMENT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'anthropic_empty_response') {
      assert.equal(protocol, 'anthropic', 'The empty-response regression used the wrong protocol')
      assert.equal(
        body.model,
        CLOUD_MODEL_CASES.find(model => model.protocol === 'anthropic')?.modelId,
        'The empty-response regression used the wrong cloud model'
      )
      this.recordScenarioRequest('anthropic_empty_response', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(ANTHROPIC_EMPTY_PROMPT),
        'The Anthropic empty-response request lost the user prompt'
      )
      const requests = this.scenarioRequests.get('anthropic_empty_response') ?? []
      if (requests.length === 1) {
        this.writeAnthropicSse(response, [
          [
            'message_start',
            {
              type: 'message_start',
              message: {
                id: 'anthropic-empty-response',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'kimi-k2.5',
                stop_reason: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          ],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 157 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ])
        return
      }
      this.writeAnthropicMessage(response, ANTHROPIC_EMPTY_COMPLETION_TEXT)
      return
    }

    // Codex CLI 0.144 can prewarm a custom Responses provider before adding
    // tool definitions or request metadata. It must not advance the task loop.
    if (
      this.scenario === 'initial' &&
      this.modelStage === 'initial' &&
      !this.toolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.toolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'embedded_browser_setup' &&
      !this.embeddedBrowserSetupToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.embeddedBrowserSetupToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'view_image' &&
      this.viewImageStage === 'initial' &&
      !this.viewImageToolLessPrewarmHandled &&
      !requestAdvertisesViewImageTool(body)
    ) {
      this.viewImageToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'cloud_initial' &&
      this.cloudModelStage === 'initial' &&
      !this.cloudToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.cloudToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'memory' &&
      this.memoryStage === 'initial' &&
      !this.memoryToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.memoryToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (
      this.scenario === 'official_plugin' &&
      !this.officialPluginToolLessPrewarmHandled &&
      !requestAdvertisesShellTool(body)
    ) {
      this.officialPluginToolLessPrewarmHandled = true
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (this.scenario === 'tool_block_order' && !requestAdvertisesShellTool(body)) {
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    if (this.scenario === 'local_markdown_image') {
      this.recordScenarioRequest('local_markdown_image', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(LOCAL_MARKDOWN_IMAGE_PROMPT),
        'The real Codex request did not contain the local Markdown image prompt'
      )
      const imageUrl = pathToFileURL(join(tmpdir(), LOCAL_MARKDOWN_IMAGE_FILENAME)).href
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`![${LOCAL_MARKDOWN_IMAGE_ALT}](${imageUrl})`),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'tool_block_order') {
      this.recordScenarioRequest('tool_block_order', modelRequest)
      const requestNumber = this.scenarioRequests.get('tool_block_order').length
      const requestText = JSON.stringify(body)

      if (requestNumber === 1) {
        assert.ok(
          requestText.includes(TOOL_BLOCK_ORDER_PROMPT),
          'The real Codex request did not contain the tool-block-order prompt'
        )
        const tool = selectShellToolCommand(body, 'printf earlier-created-tool', this.workspacePath)
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall(EARLIER_TOOL_BLOCK_ID, tool.name, tool.arguments),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 2) {
        assert.equal(
          requestContainsToolOutput(body, EARLIER_TOOL_BLOCK_ID),
          true,
          'The earlier command output did not return through the real Codex tool loop'
        )
        const search = selectToolSearch(body, 'node_repl js')
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchResponseEvents(NODE_REPL_TOOL_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 3) {
        const tool = selectMcpTool(body, 'node_repl', 'js', {
          code: "nodeRepl.write({ status: 'ready', value: 42 })",
        })
        this.writeSse(response, [
          responseCreated(responseId),
          ...namespacedFunctionCall(
            NODE_REPL_TOOL_BLOCK_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          ),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 4) {
        assert.equal(
          requestContainsToolOutput(body, NODE_REPL_TOOL_BLOCK_ID),
          true,
          'The Node REPL output did not return through the real Codex tool loop'
        )
        assert.ok(
          requestText.includes("{ status: 'executed', result: 84 }"),
          'The Node REPL MCP server result was not delivered to the model service'
        )
        this.resolveToolBlockNodeOutputObserved()
        await this.toolBlockNodeRelease
        const search = selectToolSearch(body, 'github issue details')
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchResponseEvents(GENERIC_MCP_TOOL_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 5) {
        const tool = selectMcpTool(body, 'github__issues', 'get_issue_details', {
          owner: 'wecode-ai',
          repo: 'Wegent',
          issue_number: 123,
        })
        this.writeSse(response, [
          responseCreated(responseId),
          ...namespacedFunctionCall(
            GENERIC_MCP_TOOL_BLOCK_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          ),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 6) {
        assert.equal(
          requestContainsToolOutput(body, GENERIC_MCP_TOOL_BLOCK_ID),
          true,
          'The generic MCP output did not return through the real Codex tool loop'
        )
        assert.ok(
          requestText.includes('Tool detail verification'),
          'The generic MCP server result was not delivered to the model service'
        )
        this.resolveToolBlockGenericOutputObserved()
        await this.toolBlockGenericRelease
        const tool = selectShellToolCommand(body, 'printf later-created-tool', this.workspacePath)
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall(LATER_TOOL_BLOCK_ID, tool.name, tool.arguments),
          responseCompleted(responseId),
        ])
        return
      }

      assert.equal(requestNumber, 7, `Unexpected tool-block-order request ${requestNumber}`)
      assert.equal(
        requestContainsToolOutput(body, LATER_TOOL_BLOCK_ID),
        true,
        'The later command output did not return through the real Codex tool loop'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(TOOL_BLOCK_ORDER_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'initial' && this.modelStage === 'initial') {
      this.recordScenarioRequest('initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(TASK_PROMPT),
        'The real Codex request did not contain the UI task prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      const patch = selectApplyPatchTool(body)
      const image = selectViewImageTool(body, this.workspacePath)
      this.modelStage = 'awaiting_tool_output'
      await this.initialToolRelease
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-e2e-tool-call', tool.name, tool.arguments),
        ...functionCall('wework-e2e-view-image', image.name, image.arguments, 1),
        customToolCall('wework-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'embedded_browser_setup') {
      this.recordScenarioRequest('embedded_browser_setup', modelRequest)
      const requestNumber = this.scenarioRequests.get('embedded_browser_setup').length
      const serialized = JSON.stringify(body)
      assert.ok(
        serialized.includes(EMBEDDED_BROWSER_SETUP_PROMPT),
        'The embedded-browser setup request lost its local-task prompt'
      )

      if (requestNumber === 1) {
        const search = selectToolSearch(body, 'Wework browser open')
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchResponseEvents(EMBEDDED_BROWSER_SETUP_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 2) {
        assert.equal(
          requestContainsToolOutput(body, EMBEDDED_BROWSER_SETUP_SEARCH_ID),
          true,
          'The embedded-browser tool search output did not return to the model'
        )
        const searchOutput = toolOutputText(body, EMBEDDED_BROWSER_SETUP_SEARCH_ID)
        assert.ok(searchOutput, 'The embedded-browser tool search output was empty')
        const browserToolAvailable = searchOutput.includes('"name":"wework_browser"')
        if (!browserToolAvailable) {
          this.writeSse(response, [
            responseCreated(responseId),
            assistantMessage(EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT),
            responseCompleted(responseId),
          ])
          return
        }
        const browserTool = selectMcpTool(body, 'wework_browser', 'browser_open', {
          url: new URL('/embedded-browser-agent-fixture', this.url).href,
        })
        this.writeSse(response, [
          responseCreated(responseId),
          ...namespacedFunctionCall(
            EMBEDDED_BROWSER_SETUP_OPEN_ID,
            browserTool.namespace,
            browserTool.name,
            browserTool.arguments
          ),
          responseCompleted(responseId),
        ])
        return
      }

      assert.equal(requestNumber, 3, `Unexpected embedded-browser setup request ${requestNumber}`)
      assert.equal(
        requestContainsToolOutput(body, EMBEDDED_BROWSER_SETUP_OPEN_ID),
        true,
        'The embedded-browser open output did not return to the model'
      )
      assert.ok(
        findNestedString(
          body,
          value => value.includes('"ok": true') || value.includes('\\"ok\\": true')
        ),
        'The real Codex browser_open call did not complete successfully'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'initial') {
      assert.equal(
        this.modelStage,
        'awaiting_tool_output',
        `Unexpected desktop E2E model stage: ${this.modelStage}`
      )
      this.recordScenarioRequest('initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body, 'wework-e2e-view-image'),
        true,
        'The real Codex request did not report the view_image tool output to the model service'
      )
      this.toolOutput = JSON.stringify(body.input)
      this.modelStage = 'complete'
      // Let the workbench commit the completed tool items before the final response
      // triggers a transcript refresh. Real providers have network latency here; an
      // immediate mock response can otherwise race the live image-view rendering.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
      if (this.initialCompletionHeld) {
        const text = `${BACKGROUND_GUIDANCE_CONTINUATION}\n\n${COMPLETION_TEXT}`
        const stream = streamingTextEvents(responseId, text)
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(
          createSse([
            ...stream.start,
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: BACKGROUND_GUIDANCE_CONTINUATION,
              offset: 0,
            },
          ])
        )
        await this.initialCompletionRelease
        response.end(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: `\n\n${COMPLETION_TEXT}`,
              offset: BACKGROUND_GUIDANCE_CONTINUATION.length,
            },
            ...stream.finish,
          ])
        )
        return
      }
      const responseEvents = [
        responseCreated(responseId),
        encryptedReasoningItem('wework-e2e-encrypted-reasoning', FORK_ENCRYPTED_CONTENT),
        assistantMessage(COMPLETION_TEXT),
        responseCompleted(responseId),
      ]
      this.writeSse(response, responseEvents)
      return
    }

    if (this.scenario === 'guidance_scroll') {
      this.recordScenarioRequest('guidance_scroll', modelRequest)
      if (this.guidanceScrollStage === 'setup') {
        assert.ok(
          JSON.stringify(body).includes(GUIDANCE_SCROLL_PROMPT),
          'The guidance scroll setup prompt was lost'
        )
        this.guidanceScrollStage = 'active'
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(GUIDANCE_SCROLL_RESPONSE),
          responseCompleted(responseId),
        ])
        return
      }

      if (this.guidanceScrollStage === 'active') {
        assert.ok(
          JSON.stringify(body).includes(GUIDANCE_SCROLL_ACTIVE_PROMPT),
          'The guidance scroll active prompt was lost'
        )
        const tool = selectShellTool(body, this.workspacePath)
        this.guidanceScrollStage = 'awaiting_tool_output'
        await this.guidanceScrollToolRelease
        const preToolMessage = assistantMessage(GUIDANCE_SCROLL_PRE_TOOL_TEXT)
        this.writeSse(response, [
          responseCreated(responseId),
          preToolMessage,
          ...functionCall('wework-e2e-guidance-scroll-tool', tool.name, tool.arguments),
          responseCompleted(responseId, [preToolMessage.item]),
        ])
        return
      }

      assert.equal(
        this.guidanceScrollStage,
        'awaiting_tool_output',
        `Unexpected guidance scroll model stage: ${this.guidanceScrollStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The guided turn did not return its tool output'
      )
      this.guidanceScrollStage = 'complete'
      await this.guidanceScrollCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GUIDANCE_SCROLL_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'view_image' && this.viewImageStage === 'initial') {
      this.recordScenarioRequest('view_image', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(VIEW_IMAGE_PROMPT),
        'The real Codex request did not contain the view_image prompt'
      )
      const image = selectViewImageTool(body, this.workspacePath)
      this.viewImageStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-e2e-view-image', image.name, image.arguments),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'view_image') {
      assert.equal(
        this.viewImageStage,
        'awaiting_tool_output',
        `Unexpected desktop E2E view_image stage: ${this.viewImageStage}`
      )
      this.recordScenarioRequest('view_image', modelRequest)
      assert.equal(
        requestContainsToolOutput(body, 'wework-e2e-view-image'),
        true,
        'The real Codex request did not report the view_image tool output to the model service'
      )
      this.viewImageStage = 'complete'
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(VIEW_IMAGE_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'concurrent_memory') {
      const promptMatch = JSON.stringify(body).match(/WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_(\d+)/)
      assert.ok(promptMatch, 'Concurrent memory request did not contain a task UI prompt')
      const taskNumber = Number(promptMatch[1])
      assert.ok(
        taskNumber >= 1 && taskNumber <= CONCURRENT_MEMORY_TASK_COUNT,
        `Concurrent memory request contained invalid task number ${taskNumber}`
      )
      if (!this.concurrentMemoryTaskNumbers.has(taskNumber)) {
        this.concurrentMemoryTaskNumbers.add(taskNumber)
        this.recordScenarioRequest('concurrent_memory', modelRequest)
      }
      const stream = streamingTextEvents(responseId, `Concurrent task ${taskNumber} completed.`)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(
        createSse([
          ...stream.start,
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: `Concurrent task ${taskNumber} is running.`,
            offset: 0,
          },
        ])
      )
      this.concurrentMemoryResponses.push({ response, stream })
      return
    }

    if (this.scenario === 'memory' && this.memoryStage === 'initial') {
      this.recordScenarioRequest('memory', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(MEMORY_PROMPT),
        'The real Codex request did not contain the memory E2E prompt'
      )
      const tool = selectShellTool(body, this.workspacePath)
      this.memoryStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-memory-tool-call', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'memory') {
      this.recordScenarioRequest('memory', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real Codex request did not report the memory E2E tool output'
      )
      this.memoryStage = 'streaming'
      await this.writeStreamingMarkdown(response, responseId, streamingMarkdownReport())
      this.memoryStage = 'complete'
      return
    }

    if (this.scenario === 'cloud_initial' && this.cloudModelStage === 'initial') {
      this.recordScenarioRequest('cloud_initial', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_TASK_PROMPT),
        'The real cloud Codex request did not contain the UI task prompt'
      )
      const tool = selectShellToolCommand(
        body,
        `printf '%s' "$WEGENT_SKILL_USER_NAME"`,
        this.cloudWorkspacePath
      )
      const patch = selectCloudApplyPatchTool(body)
      this.cloudModelStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall(CLOUD_RUNTIME_IDENTITY_TOOL_CALL_ID, tool.name, tool.arguments),
        customToolCall('wework-cloud-e2e-apply-patch', 'apply_patch', patch),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cloud_initial') {
      this.recordScenarioRequest('cloud_initial', modelRequest)
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The real cloud Codex request did not report its tool output to the model service'
      )
      const identityToolOutput = toolOutputText(body, CLOUD_RUNTIME_IDENTITY_TOOL_CALL_ID) ?? ''
      assert.equal(
        identityToolOutput.trim().endsWith(`Output:\n${CLOUD_AUTHENTICATED_USER_NAME}`),
        true,
        'The real cloud executor did not expose the authenticated Wework user identity'
      )
      const stream = streamingTextEvents(responseId, CLOUD_COMPLETION_TEXT)
      this.cloudModelStage = 'streaming'
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(
        createSse([
          ...stream.start,
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: CLOUD_COMPLETION_TEXT,
            offset: 0,
          },
        ])
      )
      await this.cloudInitialRelease
      this.cloudModelStage = 'complete'
      response.end(createSse(stream.finish))
      return
    }

    if (this.scenario === 'cloud_follow_up') {
      this.recordScenarioRequest('cloud_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_FOLLOW_UP_PROMPT),
        'The real cloud Codex request did not contain the follow-up prompt'
      )
      const stream = streamingTextEvents(responseId, CLOUD_FOLLOW_UP_COMPLETION_TEXT)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(
        createSse([
          ...stream.start,
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: CLOUD_FOLLOW_UP_COMPLETION_TEXT,
            offset: 0,
          },
        ])
      )
      await this.cloudFollowUpRelease
      response.end(createSse(stream.finish))
      return
    }

    if (this.scenario === 'follow_up') {
      this.recordScenarioRequest('follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the follow-up prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      await this.followUpRelease
      response.end(
        createSse([assistantMessage(FOLLOW_UP_COMPLETION_TEXT), responseCompleted(responseId)])
      )
      return
    }

    if (this.scenario === 'cloud_goal_restart') {
      this.recordScenarioRequest('cloud_goal_restart', modelRequest)
      if (this.cloudGoalRestartStage === 'initial') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_RESTART_PROMPT),
          'The real Codex request did not contain the cloud Goal restart prompt'
        )
        this.cloudGoalRestartStage = 'continuation'
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(GOAL_RESTART_INITIAL_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      if (this.cloudGoalRestartStage === 'continuation') {
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        this.cloudGoalRestartStage = 'awaiting_update_output'
        await this.goalRestartResumeRelease
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall(
            'wework-e2e-cloud-goal-restart-complete',
            updateGoal.name,
            updateGoal.arguments
          ),
          responseCompleted(responseId),
        ])
        return
      }
      assert.equal(
        this.cloudGoalRestartStage,
        'awaiting_update_output',
        `Unexpected cloud Goal restart model stage: ${this.cloudGoalRestartStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The cloud Goal continuation did not return its update_goal output'
      )
      this.cloudGoalRestartStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GOAL_RESTART_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'goal_restart') {
      this.recordScenarioRequest('goal_restart', modelRequest)
      if (this.goalRestartStage === 'initial') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_RESTART_PROMPT),
          'The real Codex request did not contain the Goal restart prompt'
        )
        this.goalRestartStage = 'continuation'
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(GOAL_RESTART_INITIAL_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      if (this.goalRestartStage === 'continuation') {
        this.goalRestartStage = 'waiting_resume'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await new Promise(resolvePromise => response.once('close', resolvePromise))
        return
      }
      if (this.goalRestartStage === 'waiting_resume') {
        assert.equal(
          this.goalRestartResumeRequested,
          true,
          'The interrupted Goal resumed without explicit user input'
        )
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        this.goalRestartStage = 'awaiting_resume_release'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await this.goalRestartResumeRelease
        response.end(
          createSse([
            ...functionCall(
              'wework-e2e-goal-restart-complete',
              updateGoal.name,
              updateGoal.arguments
            ),
            responseCompleted(responseId),
          ])
        )
        return
      }
      assert.equal(
        this.goalRestartStage,
        'awaiting_resume_release',
        `Unexpected Goal restart model stage: ${this.goalRestartStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The resumed Goal did not return its update_goal output'
      )
      this.goalRestartStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GOAL_RESTART_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'goal_idle') {
      this.recordScenarioRequest('goal_idle', modelRequest)
      if (this.goalIdleStage === 'initial') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_IDLE_PROMPT),
          'The real Codex request did not contain the Goal idle prompt'
        )
        const stream = streamingTextEvents(responseId, GOAL_IDLE_INITIAL_TEXT)
        this.goalIdleStage = 'continuation'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse(stream.start))
        await this.goalIdleInitialRelease
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: GOAL_IDLE_INITIAL_TEXT,
              offset: 0,
            },
          ])
        )
        response.end(createSse(stream.finish))
        return
      }
      if (this.goalIdleStage === 'continuation') {
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        this.goalIdleStage = 'awaiting_update_output'
        await this.goalIdleContinuationRelease
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall('wework-e2e-goal-idle-complete', updateGoal.name, updateGoal.arguments),
          responseCompleted(responseId),
        ])
        return
      }
      assert.equal(
        this.goalIdleStage,
        'awaiting_update_output',
        `Unexpected Goal idle model stage: ${this.goalIdleStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The Goal continuation did not return its update_goal output'
      )
      this.goalIdleStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GOAL_IDLE_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'goal_busy_handoff') {
      this.recordScenarioRequest('goal_busy_handoff', modelRequest)
      if (this.goalBusyStage === 'plan') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_BUSY_PLAN_PROMPT),
          'The real Codex request did not contain the busy Goal planning prompt'
        )
        this.goalBusyStage = 'goal'
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await this.goalBusyPlanRelease
        response.end(
          createSse([assistantMessage(GOAL_BUSY_PLAN_TEXT), responseCompleted(responseId)])
        )
        return
      }
      if (this.goalBusyStage === 'goal') {
        assert.ok(
          JSON.stringify(body).includes(GOAL_BUSY_OBJECTIVE),
          'The automatically started Goal request did not contain its objective'
        )
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        this.goalBusyStage = 'awaiting_update_output'
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall('wework-e2e-goal-busy-complete', updateGoal.name, updateGoal.arguments),
          responseCompleted(responseId),
        ])
        return
      }
      assert.equal(
        this.goalBusyStage,
        'awaiting_update_output',
        `Unexpected busy Goal handoff model stage: ${this.goalBusyStage}`
      )
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The busy Goal handoff did not return its update_goal output'
      )
      this.goalBusyStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(GOAL_BUSY_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'running_fork_follow_up') {
      this.recordScenarioRequest('running_fork_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RUNNING_FORK_FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the running-fork follow-up prompt'
      )
      const stream = streamingTextEvents(responseId, RUNNING_FORK_COMPLETION_TEXT)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse(stream.start))
      await this.runningForkFollowUpRelease
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: RUNNING_FORK_COMPLETION_TEXT,
            offset: 0,
          },
        ])
      )
      response.end(createSse(stream.finish))
      return
    }

    if (this.scenario === 'fork_follow_up') {
      this.recordScenarioRequest('fork_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FORK_FOLLOW_UP_PROMPT),
        'The real Codex request did not contain the fork follow-up prompt'
      )
      const encryptedHistoryPresent = JSON.stringify(body).includes(FORK_ENCRYPTED_CONTENT)
      if (encryptedHistoryPresent) {
        const responseBody = {
          error: {
            message:
              'The encrypted content gAAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_encrypted_content',
          },
        }
        json(response, 400, responseBody)
        return
      }
      const responseEvents = [
        responseCreated(responseId),
        assistantMessage(FORK_FOLLOW_UP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ]
      this.writeSse(response, responseEvents)
      return
    }

    if (this.scenario === 'workspace_selection_streaming') {
      this.recordScenarioRequest('workspace_selection_streaming', modelRequest)
      assert.ok(
        JSON.stringify(body).includes('WEWORK_DESKTOP_E2E_WORKSPACE_SELECTION_STREAMING'),
        'The real Codex request did not contain the workspace-selection streaming prompt'
      )
      const stream = streamingTextEvents(
        responseId,
        Array.from(
          { length: 40 },
          (_, index) => `Workspace selection background update ${index + 1}.\n`
        ).join('')
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse(stream.start))
      let offset = 0
      for (const delta of stream.chunks) {
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta,
              offset,
            },
          ])
        )
        offset += [...delta].length
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
      }
      response.end(createSse(stream.finish))
      return
    }

    if (this.scenario === 'window_lifecycle') {
      this.recordScenarioRequest('window_lifecycle', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(WINDOW_LIFECYCLE_PROMPT),
        'The real Codex request did not contain the window-lifecycle prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      this.resolveWindowLifecycleResponseStarted()
      await this.windowLifecycleRelease
      response.end(
        createSse([
          assistantMessage(WINDOW_LIFECYCLE_COMPLETION_RESPONSE),
          responseCompleted(responseId),
        ])
      )
      return
    }

    if (this.scenario === 'background_completion_restore') {
      this.recordScenarioRequest('background_completion_restore', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(BACKGROUND_COMPLETION_RESTORE_PROMPT),
        'The real Codex request did not contain the background-completion restore prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      this.resolveBackgroundCompletionRestoreResponseStarted()
      await this.backgroundCompletionRestoreRelease
      response.end(
        createSse([
          assistantMessage(BACKGROUND_COMPLETION_RESTORE_TEXT),
          responseCompleted(responseId),
        ])
      )
      return
    }

    if (this.scenario === 'background_follow_up_restore') {
      this.recordScenarioRequest('background_follow_up_restore', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(BACKGROUND_FOLLOW_UP_RESTORE_PROMPT),
        'The real Codex request did not contain the background follow-up restore prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      this.resolveBackgroundFollowUpRestoreResponseStarted()
      await this.backgroundFollowUpRestoreRelease
      response.end(
        createSse([
          assistantMessage(BACKGROUND_FOLLOW_UP_RESTORE_TEXT),
          responseCompleted(responseId),
        ])
      )
      return
    }

    if (this.scenario === 'turn_navigation') {
      this.recordScenarioRequest('turn_navigation', modelRequest)
      const serializedBody = JSON.stringify(body)
      const turnMatch = Array.from(
        serializedBody.matchAll(
          new RegExp(`${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_(\\d+)`, 'g')
        )
      ).at(-1)
      assert.ok(turnMatch, 'The turn-navigation request did not include its turn number')
      const turnNumber = Number(turnMatch[1])
      const completionText = `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`
      const responseText = [
        completionText,
        ...Array.from(
          { length: 6 },
          (_, paragraphIndex) =>
            `Virtualized navigation response ${turnNumber}.${paragraphIndex + 1}. ${'Measured content '.repeat(12)}`
        ),
      ].join('\n\n')
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(responseText),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'request_user_input') {
      this.recordScenarioRequest('request_user_input', modelRequest)
      if (JSON.stringify(body.input).includes('wework-e2e-request-user-input')) {
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(REQUEST_USER_INPUT_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
      assert.ok(
        JSON.stringify(body).includes(REQUEST_USER_INPUT_PROMPT),
        'The real Codex request did not contain the request-user-input prompt'
      )
      const tool = selectTool(body, 'request_user_input', {
        questions: [
          {
            header: 'Direction',
            id: 'direction',
            question: REQUEST_USER_INPUT_QUESTION,
            options: [
              { label: 'Minimal', description: 'Make the smallest focused change.' },
              { label: 'Complete', description: 'Cover the full interaction flow.' },
            ],
          },
        ],
      })
      await this.requestUserInputRelease
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-e2e-request-user-input', tool.name, tool.arguments),
        responseCompleted(responseId),
      ])
      this.resolveRequestUserInputResponseWritten()
      return
    }

    if (this.scenario === 'mcp_elicitation') {
      this.recordScenarioRequest('mcp_elicitation', modelRequest)
      const requestNumber = this.scenarioRequests.get('mcp_elicitation').length
      const requestText = JSON.stringify(body)

      if (requestNumber === 1) {
        assert.ok(
          requestText.includes(MCP_ELICITATION_PROMPT),
          'The real Codex request did not contain the MCP elicitation prompt'
        )
        const search = selectToolSearch(body, MCP_ELICITATION_TOOL_NAME)
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchResponseEvents(MCP_ELICITATION_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 2) {
        const tool = selectMcpTool(body, MCP_ELICITATION_NAMESPACE, MCP_ELICITATION_TOOL_NAME, {})
        this.writeSse(response, [
          responseCreated(responseId),
          ...namespacedFunctionCall(
            MCP_ELICITATION_CALL_ID,
            tool.namespace,
            tool.name,
            tool.arguments
          ),
          responseCompleted(responseId),
        ])
        return
      }

      assert.equal(requestNumber, 3, `Unexpected MCP elicitation request ${requestNumber}`)
      assert.ok(
        requestContainsToolOutput(body, MCP_ELICITATION_CALL_ID),
        'The MCP elicitation tool output did not return to the real model request'
      )
      assert.ok(
        requestText.includes(MCP_ELICITATION_ACCEPTED_MARKER),
        'The MCP server did not return the accepted audience marker to the model'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(MCP_ELICITATION_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'task_plan') {
      this.recordScenarioRequest('task_plan', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(TASK_PLAN_PROMPT),
        'The real Codex request did not contain the task-plan prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      await this.taskPlanCompletionRelease
      response.end(
        createSse([
          assistantMessage(
            [
              '<proposed_plan>',
              '# Background plan',
              `- ${TASK_PLAN_STEP}`,
              '</proposed_plan>',
            ].join('\n')
          ),
          responseCompleted(responseId),
        ])
      )
      this.resolveTaskPlanCompletionWritten()
      return
    }

    if (this.scenario === 'official_plugin') {
      this.recordScenarioRequest('official_plugin', modelRequest)
      const requestNumber = this.scenarioRequests.get('official_plugin').length
      const requestText = JSON.stringify(body)
      const skillPath = this.officialPluginSkillPath
      assert.ok(skillPath, 'The official plugin scenario did not receive the installed skill path')

      if (requestNumber === 1) {
        assert.ok(
          requestText.includes(OFFICIAL_PLUGIN_NAME) &&
            requestText.includes(OFFICIAL_PLUGIN_SKILL_NAME) &&
            requestContainsSkillLocator(body, skillPath, OFFICIAL_PLUGIN_SKILL_NAME),
          'The real Codex request did not inject the selected official plugin skill'
        )
        const shell = selectShellToolCommand(
          body,
          `sed -n '1,12p' ${JSON.stringify(skillPath)}`,
          this.workspacePath
        )
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall('wework-e2e-official-plugin-skill', shell.name, shell.arguments),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 2) {
        assert.ok(
          requestText.includes(OFFICIAL_PLUGIN_SKILL_MARKER),
          'The official plugin skill file was not read through the real Codex tool loop'
        )
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(OFFICIAL_PLUGIN_SKILL_READY_TEXT),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 3) {
        const search = selectToolSearch(
          body,
          `${OFFICIAL_PLUGIN_DISPLAY_NAME} ${OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION}`
        )
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchResponseEvents(OFFICIAL_PLUGIN_MCP_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 4) {
        const mcpTool = selectOfficialPluginMcpTool(body, {
          workspacePath: this.workspacePath,
          targetPath: '../outside.env',
          envName: 'OPENAI_API_KEY',
        })
        this.writeSse(response, [
          responseCreated(responseId),
          ...namespacedFunctionCall(
            'wework-e2e-official-plugin-mcp',
            mcpTool.namespace,
            mcpTool.name,
            mcpTool.arguments
          ),
          responseCompleted(responseId),
        ])
        return
      }

      assert.equal(requestNumber, 5, `Unexpected official plugin request ${requestNumber}`)
      assert.ok(
        requestText.includes('The env file must be inside the selected workspace.'),
        'The official plugin MCP server did not execute and return its validation result'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(OFFICIAL_PLUGIN_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'skill_mention_display') {
      this.recordScenarioRequest('skill_mention_display', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(QUALIFIED_SKILL_MENTION_PROMPT) &&
          requestText.includes(`${OFFICIAL_PLUGIN_NAME}:${OFFICIAL_PLUGIN_SKILL_NAME}`) &&
          requestText.includes(this.officialPluginSkillPath),
        'The real Codex request did not preserve the qualified structured skill mention'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(QUALIFIED_SKILL_MENTION_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'checkpoint_task') {
      this.recordScenarioRequest('checkpoint_task', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CHECKPOINT_TASK_PROMPT),
        'The checkpoint fixture prompt was lost'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(CHECKPOINT_TASK_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'worktree_queue_hold' || this.scenario === 'worktree_restart_hold') {
      const scenario = this.scenario
      const held = this.heldScenarioResponses.get(scenario)
      assert.ok(held, `The ${scenario} response was not held before the task started`)
      this.recordScenarioRequest(scenario, modelRequest)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(createSse([responseCreated(responseId)]))
      await held.promise
      if (!response.writableEnded && !response.destroyed) {
        response.end(
          createSse([
            assistantMessage(`${scenario.toUpperCase()}_COMPLETE`),
            responseCompleted(responseId),
          ])
        )
      }
      return
    }

    if (this.scenario === 'message_edit') {
      this.recordScenarioRequest('message_edit', modelRequest)
      const latestInput = latestModelInputText(body)
      const requestNumber = this.scenarioRequests.get('message_edit').length
      if (requestNumber === 1) {
        assert.ok(
          latestInput.includes(MESSAGE_EDIT_ORIGINAL_PROMPT),
          'The message-edit setup request lost its original prompt'
        )
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(MESSAGE_EDIT_ORIGINAL_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }

      assert.equal(requestNumber, 2, `Unexpected message-edit request ${requestNumber}`)
      assert.ok(
        latestInput.includes(MESSAGE_EDIT_UPDATED_PROMPT),
        'Editing the last user message resent stale content instead of the updated prompt'
      )
      assert.equal(
        latestInput.includes(MESSAGE_EDIT_ORIGINAL_PROMPT),
        false,
        'The edited turn retained the original prompt in the latest model input'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(MESSAGE_EDIT_UPDATED_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'file_panel_anchor') {
      this.recordScenarioRequest('file_panel_anchor', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FILE_PANEL_ANCHOR_PROMPT),
        'The file panel anchor prompt was lost'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(
          FILE_PANEL_ANCHOR_RESPONSE.replace(
            `${FILE_PANEL_LINK_NAME.replaceAll(' ', '%20')}:1`,
            `${pathToFileURL(join(this.workspacePath, FILE_PANEL_LINK_NAME)).href}:1`
          )
        ),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'automation') {
      this.recordScenarioRequest('automation', modelRequest)
      if (this.automationStage === 'manual_goal' || this.automationStage === 'scheduled_goal') {
        assert.ok(
          JSON.stringify(body).includes(AUTOMATION_PROMPT),
          'The automation prompt was lost before model execution'
        )
        const updateGoal = selectTool(body, 'update_goal', { status: 'complete' })
        const callId =
          this.automationStage === 'manual_goal'
            ? 'wework-e2e-automation-manual-goal'
            : 'wework-e2e-automation-scheduled-goal'
        this.automationStage =
          this.automationStage === 'manual_goal' ? 'manual_goal_output' : 'scheduled_goal_output'
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall(callId, updateGoal.name, updateGoal.arguments),
          responseCompleted(responseId),
        ])
        return
      }
      assert.equal(
        requestContainsToolOutput(body),
        true,
        'The automation Goal did not return its update_goal output'
      )
      const manualRun = this.automationStage === 'manual_goal_output'
      assert.ok(
        manualRun || this.automationStage === 'scheduled_goal_output',
        `Unexpected automation model stage: ${this.automationStage}`
      )
      this.automationStage = manualRun ? 'scheduled_goal' : 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`${AUTOMATION_COMPLETION_TEXT}_${manualRun ? 1 : 2}`),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'fresh_chat') {
      this.recordScenarioRequest('fresh_chat', modelRequest)
      assert.ok(JSON.stringify(body).includes(FRESH_CHAT_PROMPT), 'The fresh chat prompt was lost')
      assert.equal(
        JSON.stringify(body).includes(TASK_PROMPT),
        false,
        'The new conversation inherited the previous task context'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(FRESH_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'supervisor') {
      this.recordScenarioRequest('supervisor', modelRequest)
      const requestText = JSON.stringify(body)
      if (body.metadata?.source === 'wework-supervisor') {
        assert.equal(body.stream, false, 'The supervisor evaluator request must not stream')
        assert.ok(
          requestText.includes('correction'),
          'The supervisor evaluator request did not include its structured output schema'
        )
        assert.ok(
          requestText.includes(SUPERVISOR_COMPLETION_TEXT),
          'The supervisor evaluator did not receive the latest assistant progress'
        )
        assert.equal(
          requestText.includes(SUPERVISOR_PROMPT),
          false,
          'The supervisor evaluator received the original user transcript instead of recent AI content'
        )
        json(response, 200, {
          id: responseId,
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [
            {
              id: `supervisor-evaluation-${responseId}`,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    correction: SUPERVISOR_CORRECTION,
                    rationale: 'The completed reply should restate the original constraint.',
                  }),
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 0,
            input_tokens_details: null,
            output_tokens: 0,
            output_tokens_details: null,
            total_tokens: 0,
          },
        })
        return
      }
      if (requestText.includes(SUPERVISOR_CORRECTION)) {
        const stream = streamingTextEvents(responseId, SUPERVISOR_CORRECTION_COMPLETION_TEXT)
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse(stream.start))
        this.resolveSupervisorCorrectionStarted()
        await this.supervisorCorrectionRelease
        response.write(
          createSse([
            {
              type: 'response.output_text.delta',
              item_id: stream.itemId,
              output_index: 0,
              content_index: 0,
              delta: SUPERVISOR_CORRECTION_COMPLETION_TEXT,
              offset: 0,
            },
          ])
        )
        response.end(createSse(stream.finish))
        return
      }
      assert.ok(requestText.includes(SUPERVISOR_PROMPT), 'The supervisor task prompt was lost')
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(
        createSse([responseCreated(responseId), assistantMessage(SUPERVISOR_COMPLETION_TEXT)])
      )
      await this.supervisorInitialRelease
      response.end(createSse([responseCompleted(responseId)]))
      return
    }

    if (this.scenario === 'attachment_only') {
      this.recordScenarioRequest('attachment_only', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(ATTACHMENT_ONLY_FILENAME),
        'The attachment-only request did not contain the selected file'
      )
      const requestNumber = this.scenarioRequests.get('attachment_only').length
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`${ATTACHMENT_ONLY_COMPLETION_TEXT}_${requestNumber}`),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'pasted_zip_attachment') {
      this.recordScenarioRequest('pasted_zip_attachment', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(
        requestText.includes(PASTED_ZIP_FILENAME),
        'The pasted ZIP filename was not forwarded to the real Codex request'
      )
      assert.ok(
        requestText.includes('application/zip'),
        'The pasted ZIP MIME type was not forwarded to the real Codex request'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PASTED_ZIP_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'pasted_workspace_paths') {
      this.recordScenarioRequest('pasted_workspace_paths', modelRequest)
      const requestText = JSON.stringify(body).replaceAll('\\', '/')
      const folderPath = join(this.workspacePath, PASTED_PATH_FOLDER_NAME).replaceAll('\\', '/')
      const filePath = join(this.workspacePath, PASTED_PATH_FILE_NAME).replaceAll('\\', '/')
      assert.ok(
        requestText.includes(folderPath),
        'The pasted folder reference was not forwarded to the real Codex request'
      )
      assert.ok(
        requestText.includes(filePath),
        'The pasted file reference was not forwarded to the real Codex request'
      )
      assert.equal(
        requestText.includes('nested path context') ||
          requestText.includes('# Pasted path context'),
        false,
        'The pasted paths copied file contents into the model request'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PASTED_PATH_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'dropped_workspace_paths') {
      this.recordScenarioRequest('dropped_workspace_paths', modelRequest)
      const requestText = JSON.stringify(body).replaceAll('\\', '/')
      const folderPath = join(this.workspacePath, DROPPED_PATH_FOLDER_NAME).replaceAll('\\', '/')
      const filePath = join(this.workspacePath, DROPPED_PATH_FILE_NAME).replaceAll('\\', '/')
      assert.ok(
        requestText.includes(folderPath),
        'The dropped folder reference was not forwarded to the real Codex request'
      )
      assert.ok(
        requestText.includes(filePath),
        'The dropped file reference was not forwarded to the real Codex request'
      )
      assert.equal(
        requestText.includes('nested dropped path context') ||
          requestText.includes('# Dropped path context'),
        false,
        'The dropped paths copied file contents into the model request'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(DROPPED_PATH_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'side_chat_attachment') {
      this.recordScenarioRequest('side_chat_attachment', modelRequest)
      const requestText = JSON.stringify(body)
      assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat request lost its prompt')
      assert.ok(
        requestText.includes(SIDE_CHAT_FILENAME),
        'The side-chat request lost its isolated attachment'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(SIDE_CHAT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'side_chat_guidance') {
      this.recordScenarioRequest('side_chat_guidance', modelRequest)
      const requestText = JSON.stringify(body)
      const requestCount = this.scenarioRequests.get('side_chat_guidance')?.length ?? 0
      if (requestCount === 1) {
        assert.ok(
          requestText.includes(SIDE_CHAT_GUIDANCE_INITIAL),
          'The initial side-chat guidance request lost its prompt'
        )
        const tool = selectShellTool(body, this.workspacePath)
        await this.sideChatGuidanceRelease
        this.writeSse(response, [
          responseCreated(responseId),
          ...functionCall('wework-e2e-side-chat-guidance-tool', tool.name, tool.arguments),
          responseCompleted(responseId),
        ])
        return
      }
      assert.equal(requestCount, 2, 'Side-chat guidance started an unexpected extra turn')
      assert.equal(
        requestContainsToolOutput(body, 'wework-e2e-side-chat-guidance-tool'),
        true,
        'The side-chat guidance turn did not return its tool output'
      )
      assert.ok(
        requestText.includes(SIDE_CHAT_GUIDANCE_FOLLOW_UP),
        'The side-chat follow-up was not delivered as guidance to the active turn'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(SIDE_CHAT_GUIDANCE_COMPLETION),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cancellation') {
      this.recordScenarioRequest('cancellation', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CANCELLATION_PROMPT),
        'The real Codex request did not contain the cancellation prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      await this.cancellationCompletionRelease
      if (response.destroyed || response.writableEnded) return
      response.end(
        createSse([assistantMessage(CANCELLATION_COMPLETION_TEXT), responseCompleted(responseId)])
      )
      return
    }

    if (this.scenario === 'send_rejection') {
      this.recordScenarioRequest('send_rejection', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(SEND_REJECTION_RUNNING_PROMPT),
        'The real Codex request did not contain the send-rejection prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      await this.sendRejectionCompletionRelease
      if (response.destroyed || response.writableEnded) return
      response.end(
        createSse([assistantMessage(SEND_REJECTION_COMPLETION_TEXT), responseCompleted(responseId)])
      )
      return
    }

    if (this.scenario === 'queue_management') {
      this.recordScenarioRequest('queue_management', modelRequest)
      const latestInput = latestModelInputText(body)
      const followUpPrompts = [
        QUEUE_DIRECT_FIRST,
        QUEUE_DIRECT_SECOND,
        QUEUE_DIRECT_THIRD,
        QUEUE_PRESERVE_QUEUED,
        QUEUE_PRESERVE_MANUAL,
        QUEUE_CLEAR_MANUAL,
      ]
      const prompt = followUpPrompts.find(candidate => latestInput.includes(candidate))
      if (prompt) {
        if (prompt !== QUEUE_DIRECT_THIRD) {
          this.writeSse(response, [
            responseCreated(responseId),
            assistantMessage(`${QUEUE_MANAGEMENT_COMPLETION_PREFIX}:${prompt}`),
            responseCompleted(responseId),
          ])
          return
        }
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await this.queueManagementFirstCompletionRelease
        if (response.destroyed || response.writableEnded) return
        response.end(
          createSse([
            assistantMessage(`${QUEUE_MANAGEMENT_COMPLETION_PREFIX}:${prompt}`),
            responseCompleted(responseId),
          ])
        )
        return
      }

      const initialPrompts = [QUEUE_DIRECT_INITIAL, QUEUE_PRESERVE_INITIAL, QUEUE_CLEAR_INITIAL]
      assert.ok(
        initialPrompts.some(candidate => latestInput.includes(candidate)),
        `Unexpected queue management request: ${latestInput}`
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      return
    }

    if (this.scenario === 'retry') {
      this.recordScenarioRequest('retry', modelRequest)
      const retryRequests = this.scenarioRequests.get('retry') ?? []
      if (retryRequests.length === 1) {
        assert.ok(
          latestModelInputText(body).includes(RETRY_PROMPT),
          'The initial Codex request did not contain the retry scenario prompt'
        )
        this.writeSse(response, [
          responseCreated(responseId),
          responseFailed(responseId, RETRY_FAILURE_TEXT),
        ])
        return
      }
      const continuationInput = latestModelInputText(body)
      assert.ok(
        continuationInput.includes(RETRY_CONTINUATION_PROMPT),
        'The retry action did not continue the existing Codex conversation'
      )
      assert.equal(
        continuationInput.includes(RETRY_PROMPT),
        false,
        'The retry action replayed the original user prompt'
      )
      await this.retryCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RETRY_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'rate_limit') {
      this.recordScenarioRequest('rate_limit', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RATE_LIMIT_PROMPT),
        'The real Codex request did not contain the rate-limit prompt'
      )
      const rateLimitRequests = this.scenarioRequests.get('rate_limit') ?? []
      if (rateLimitRequests.length === 1) {
        response.setHeader('Retry-After', '0')
        json(response, 429, { error: { message: 'Desktop E2E intentional rate limit' } })
        return
      }
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RATE_LIMIT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'reconnect') {
      this.recordScenarioRequest('reconnect', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RECONNECT_PROMPT),
        'The real Codex request did not contain the reconnect prompt'
      )
      const reconnectRequests = this.scenarioRequests.get('reconnect') ?? []
      if (reconnectRequests.length === 1) {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        this.resolveReconnectResponseStarted()
        await this.reconnectDisconnectRelease
        response.destroy()
        return
      }
      await this.reconnectCompletionRelease
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(RECONNECT_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    throw new Error(`Unexpected desktop E2E scenario: ${this.scenario}`)
  }

  handleProviderSwitchRetryResponse(response, protocol, body, modelRequest) {
    assert.equal(protocol, 'responses', 'The provider-switch request reached the wrong endpoint')
    const requestKind = codexRequestKind(body)
    if (requestKind === 'prewarm' || requestKind === 'compaction') {
      const responseId = `provider-switch-background-${this.modelRequests.length}`
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
      return
    }

    const serialized = JSON.stringify(body)
    this.recordScenarioRequest('provider_switch_retry', modelRequest)
    const promptRequestCount = this.scenarioRequests.get('provider_switch_retry').length
    if (promptRequestCount === 1) {
      assert.ok(
        serialized.includes(PROVIDER_SWITCH_PROMPT),
        'The Luna request lost the user prompt'
      )
      assert.equal(
        body.model,
        PROVIDER_SWITCH_LUNA_MODEL_ID,
        'The initial provider-switch turn did not reach Luna'
      )
      json(response, 400, {
        error: {
          type: 'invalid_request_error',
          message: PROVIDER_SWITCH_FAILURE,
        },
      })
      return
    }
    if (promptRequestCount === 2) {
      assert.ok(
        serialized.includes(PROVIDER_SWITCH_PROMPT),
        'The official retry lost the original user prompt'
      )
      assert.equal(
        body.model,
        PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
        `The provider-switch retry was routed to ${String(body.model)} instead of official GPT`
      )
      const responseId = 'provider-switch-gpt-complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PROVIDER_SWITCH_COMPLETION),
        responseCompleted(responseId),
      ])
      return
    }
    if (promptRequestCount === 3) {
      assert.ok(
        serialized.includes(PROVIDER_SWITCH_RESUME_PROMPT),
        'The resumed Luna turn lost the follow-up prompt'
      )
      assert.equal(
        body.model,
        PROVIDER_SWITCH_LUNA_MODEL_ID,
        `The resumed provider-switch turn was routed to ${String(body.model)} instead of Luna`
      )
      const responseId = 'provider-switch-resume-luna-complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(PROVIDER_SWITCH_RESUME_COMPLETION),
        responseCompleted(responseId),
      ])
      return
    }
    throw new Error(`The provider-switch prompt was sent ${promptRequestCount} times`)
  }

  handleModelProtocolMatrixResponse(response, protocol, body, headers) {
    const model = this.matrixCase
    const state = this.matrixState
    assert.ok(model && state, 'Model protocol matrix state was not initialized')
    assert.equal(protocol, model.protocol, `${matrixCaseId(model)} reached the wrong endpoint`)
    assert.equal(body.model, model.modelId, `${matrixCaseId(model)} forwarded the wrong model ID`)
    state.requests.push({ body, headers })

    const requestKind = codexRequestKind(body)
    if (requestKind === 'prewarm' || requestKind === 'compaction') {
      this.writeMatrixAssistantMessage(response, model, '')
      return
    }

    const serialized = JSON.stringify(body)
    this.assertMatrixRequestEnvelope(model, body, headers)
    this.assertMatrixTools(model, body)
    if (state.stage === 'text') {
      if (!serialized.includes(matrixTextPrompt(model))) {
        this.writeMatrixAssistantMessage(response, model, '')
        return
      }
      state.stage = 'tool'
      this.writeMatrixAssistantMessage(response, model, matrixTextCompletion(model))
      return
    }
    if (state.stage === 'tool') {
      assert.ok(
        serialized.includes(matrixToolPrompt(model)),
        `${matrixCaseId(model)} tool turn lost the user prompt`
      )
      state.stage = 'awaiting_tool_output'
      this.writeMatrixToolCall(response, model)
      return
    }
    if (state.stage === 'awaiting_tool_output') {
      this.assertMatrixToolOutput(model, body)
      state.stage = 'complete'
      this.writeMatrixAssistantMessage(response, model, matrixToolCompletion(model))
      return
    }
    throw new Error(`Unexpected ${matrixCaseId(model)} matrix request at ${state.stage}`)
  }

  assertMatrixRequestEnvelope(model, body, headers) {
    assert.equal(body.stream, true, `${matrixCaseId(model)} request was not streaming`)
    if (model.protocol === 'responses') {
      assert.ok(Array.isArray(body.input), `${matrixCaseId(model)} input was not an array`)
      return
    }
    assert.ok(Array.isArray(body.messages), `${matrixCaseId(model)} messages were not an array`)
    if (model.protocol === 'chat') {
      assert.equal(
        body.stream_options?.include_usage,
        true,
        `${matrixCaseId(model)} did not request streaming usage`
      )
      if (model.source === 'cloud' && model.modelId === 'moonshot-kimi-k3') {
        assert.deepEqual(
          body.thinking,
          { type: 'enabled' },
          `${matrixCaseId(model)} did not enable Kimi thinking`
        )
        assert.equal(
          body.reasoning_effort,
          undefined,
          `${matrixCaseId(model)} forwarded an unsupported Kimi reasoning_effort`
        )
      }
      return
    }
    assert.equal(headers['x-api-key'], MODEL_API_KEY, `${matrixCaseId(model)} lost x-api-key`)
    assert.equal(
      headers['anthropic-version'],
      '2023-06-01',
      `${matrixCaseId(model)} lost the Anthropic protocol version`
    )
  }

  assertMatrixTools(model, body) {
    const tools = Array.isArray(body.tools) ? body.tools : []
    const applyPatch = tools.find(
      candidate => (candidate?.name ?? candidate?.function?.name) === 'apply_patch'
    )
    assert.ok(applyPatch, `${matrixCaseId(model)} did not advertise apply_patch`)
    if (model.protocol === 'responses') {
      assert.equal(
        applyPatch.type,
        model.source === 'local' ? 'function' : 'custom',
        `${matrixCaseId(model)} used the wrong Responses tool profile`
      )
      return
    }
    if (model.protocol === 'chat') {
      assert.equal(applyPatch.type, 'function', `${matrixCaseId(model)} tool was not a function`)
      assert.ok(applyPatch.function?.parameters, `${matrixCaseId(model)} lost the tool schema`)
      return
    }
    assert.ok(applyPatch.input_schema, `${matrixCaseId(model)} lost input_schema`)
  }

  assertMatrixToolOutput(model, body) {
    if (model.protocol === 'responses') {
      const expectedType =
        model.source === 'local' ? 'function_call_output' : 'custom_tool_call_output'
      assert.ok(
        body.input?.some(item => item?.type === expectedType),
        `${matrixCaseId(model)} lost ${expectedType}`
      )
      return
    }
    if (model.protocol === 'chat') {
      const assistant = body.messages?.find(
        message =>
          message?.role === 'assistant' &&
          message?.content?.includes(matrixToolPreamble(model)) &&
          message?.tool_calls?.some(call => call?.function?.name === 'apply_patch')
      )
      assert.ok(
        assistant,
        `${matrixCaseId(model)} split assistant text and tool_calls into different messages`
      )
      if (model.source === 'cloud' && model.modelId === 'moonshot-kimi-k3') {
        assert.ok(
          assistant.reasoning_content?.trim(),
          `${matrixCaseId(model)} lost Kimi tool-call reasoning history`
        )
      }
      const call = assistant.tool_calls.find(
        candidate => candidate?.function?.name === 'apply_patch'
      )
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        `${matrixCaseId(model)} lost the function tool result or call ID`
      )
      return
    }
    const assistant = body.messages?.find(
      message =>
        message?.role === 'assistant' &&
        message?.content?.some(
          block => block?.type === 'text' && block?.text?.includes(matrixToolPreamble(model))
        ) &&
        message?.content?.some(block => block?.type === 'tool_use' && block?.name === 'apply_patch')
    )
    assert.ok(
      assistant,
      `${matrixCaseId(model)} split assistant text and tool_use into different messages`
    )
    const call = assistant.content.find(
      block => block?.type === 'tool_use' && block?.name === 'apply_patch'
    )
    assert.ok(
      body.messages?.some(
        message =>
          message?.role === 'user' &&
          message?.content?.some(
            block => block?.type === 'tool_result' && block?.tool_use_id === call?.id
          )
      ),
      `${matrixCaseId(model)} lost the Anthropic tool_result or tool_use_id`
    )
  }

  writeMatrixToolCall(response, model) {
    const patch = matrixPatch(model)
    if (model.protocol === 'responses') {
      const id = `matrix-${matrixCaseId(model)}-tool`
      this.writeSse(response, [
        responseCreated(id),
        ...(model.source === 'local'
          ? functionCall(id, 'apply_patch', { input: patch })
          : [customToolCall(id, 'apply_patch', patch)]),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(
        response,
        patch,
        'chat-local-apply-patch',
        'apply_patch',
        matrixToolPreamble(model)
      )
      return
    }
    this.writeAnthropicToolCall(
      response,
      patch,
      'anthropic-local-apply-patch',
      'apply_patch',
      matrixToolPreamble(model)
    )
  }

  writeMatrixAssistantMessage(response, model, text) {
    if (model.protocol === 'responses') {
      const id = `matrix-${matrixCaseId(model)}-message`
      const events = [responseCreated(id)]
      if (text) events.push(assistantMessage(text))
      events.push(responseCompleted(id))
      this.writeSse(response, events)
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatMessage(response, text)
      return
    }
    this.writeAnthropicMessage(response, text)
  }

  handleLocalProtocolResponse(response, model, body, headers) {
    const state = this.localProtocolStates.get(model.protocol)
    assert.ok(state, `Missing local protocol state for ${model.protocol}`)
    state.requests.push({ body, headers })
    const serialized = JSON.stringify(body)
    const initialPrompt = localProtocolPrompt(model, 'INITIAL')
    const followUpPrompt = localProtocolPrompt(model, 'FOLLOW_UP')

    this.assertLocalRequestEnvelope(model, body, headers)

    if (state.stage === 'model_switch_source') {
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_INITIAL_PROMPT),
        'The first custom model did not receive the model-switch initial prompt'
      )
      state.stage = 'model_switch_source_awaiting_tool_output'
      this.writeModelSwitchToolCall(response, model)
      return
    }
    if (state.stage === 'model_switch_source_awaiting_tool_output') {
      this.assertModelSwitchHistory(model, body)
      state.stage = 'model_switch_source_complete'
      this.writeLocalAssistantMessage(response, model, LOCAL_MODEL_SWITCH_INITIAL_COMPLETE)
      return
    }
    if (state.stage === 'model_switch_source_complete') {
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT),
        'The first custom model did not receive the prompt that should fail before switching'
      )
      state.stage = 'model_switch_source_failed'
      this.writeLocalError(response, model, 'WEWORK_LOCAL_MODEL_SWITCH_RETRY_FAILURE')
      return
    }
    if (state.stage === 'model_switch_source_failed' && codexRequestKind(body) === 'compaction') {
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    if (
      state.stage === 'model_switch_source_failed' &&
      serialized.includes(LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT)
    ) {
      this.writeLocalError(response, model, 'WEWORK_LOCAL_MODEL_SWITCH_RETRY_FAILURE')
      return
    }
    if (
      state.stage === 'model_switch_target' &&
      (codexRequestKind(body) === 'compaction' ||
        serialized.includes('CONTEXT CHECKPOINT COMPACTION'))
    ) {
      if (this.hasModelSwitchHistory(model, body)) {
        this.assertModelSwitchHistory(model, body)
        state.historyVerified = true
      }
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    if (state.stage === 'model_switch_target') {
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT),
        'The second custom model did not receive the follow-up after switching models'
      )
      assert.ok(
        serialized.includes(LOCAL_MODEL_SWITCH_INITIAL_COMPLETE),
        'The switched custom model did not preserve the earlier conversation context'
      )
      if (!state.historyVerified) {
        this.assertModelSwitchHistory(model, body)
        state.historyVerified = true
      }
      state.stage = 'model_switch_target_complete'
      this.writeLocalAssistantMessage(response, model, LOCAL_MODEL_SWITCH_COMPLETE)
      return
    }

    if (state.stage === 'initial' && serialized.includes(initialPrompt)) {
      this.assertLocalConversation(model, body, {
        includes: [initialPrompt],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      const search = selectToolSearch(body, 'Wework browser open')
      state.stage = 'awaiting_browser_search_output'
      this.writeLocalToolSearchCall(response, model, search)
      return
    }
    if (state.stage === 'awaiting_browser_search_output') {
      this.assertLocalConversation(model, body, {
        includes: [],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      const browserArguments = { url: this.url }
      selectMcpTool(body, 'wework_browser', 'browser_open', browserArguments)
      const browserTool = selectConvertedTool(body, 'browser_open', browserArguments)
      this.assertLocalNamespaceTools(model, body)
      state.stage = 'awaiting_namespace_tool_output'
      this.writeLocalNamespaceToolCall(response, model, browserTool)
      return
    }
    if (state.stage === 'awaiting_namespace_tool_output') {
      this.assertLocalConversation(model, body, {
        includes: [],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      this.assertLocalNamespaceTools(model, body)
      this.assertLocalNamespaceToolOutput(model, body)
      state.stage = 'awaiting_tool_output'
      this.writeLocalToolCall(response, model, localProtocolPatch(model))
      return
    }
    if (state.stage === 'awaiting_tool_output') {
      this.assertLocalConversation(model, body, {
        includes: [],
        excludes: [followUpPrompt],
      })
      this.assertLocalApplyPatchTool(model, body)
      this.assertLocalToolOutput(model, body)
      state.stage = 'complete'
      this.writeLocalAssistantMessage(
        response,
        model,
        `WEWORK_LOCAL_${model.protocol.toUpperCase()}_COMPLETE`
      )
      return
    }
    if (state.stage === 'complete' && serialized.includes(followUpPrompt)) {
      const completedMessage = `WEWORK_LOCAL_${model.protocol.toUpperCase()}_COMPLETE`
      this.assertLocalConversation(model, body, {
        includes:
          model.protocol === 'responses'
            ? [initialPrompt, followUpPrompt, completedMessage]
            : [initialPrompt, followUpPrompt, completedMessage],
        excludes: [],
      })
      this.assertLocalApplyPatchTool(model, body)
      // Stateful Responses requests may compact completed tool call/output pairs.
      // Stateless Chat and Anthropic conversions must keep the pair for history.
      if (model.protocol !== 'responses') this.assertLocalToolOutput(model, body)
      state.stage = 'follow_up_complete'
      this.writeLocalAssistantMessage(
        response,
        model,
        `WEWORK_LOCAL_${model.protocol.toUpperCase()}_FOLLOW_UP_COMPLETE`
      )
      return
    }
    // Codex may prewarm a provider before it sends the first prompt and tools.
    if (state.stage === 'initial') {
      assert.equal(
        serialized.includes(initialPrompt),
        false,
        `${model.protocol} prewarm unexpectedly contained the initial prompt`
      )
      this.writeLocalAssistantMessage(response, model, '')
      return
    }
    throw new Error(
      `Unexpected ${model.protocol} request at ${state.stage}: ${serialized.slice(0, 1000)}`
    )
  }

  assertLocalRequestEnvelope(model, body, headers) {
    assert.equal(body.model, model.modelId, `${model.protocol} forwarded the wrong model ID`)
    assert.equal(body.stream, true, `${model.protocol} request was not streaming`)
    assert.equal(
      headers.authorization,
      `Bearer ${MODEL_API_KEY}`,
      `${model.protocol} did not forward bearer authentication`
    )
    if (model.protocol === 'responses') {
      assert.ok(Array.isArray(body.input), 'Responses input was not an array')
      assert.equal(
        headers['anthropic-version'],
        undefined,
        'Responses unexpectedly received Anthropic headers'
      )
      return
    }
    assert.ok(Array.isArray(body.messages), `${model.protocol} messages were not an array`)
    if (model.protocol === 'chat') {
      assert.equal(
        body.stream_options?.include_usage,
        true,
        'Chat streaming usage metadata was not requested'
      )
      assert.equal(
        headers['anthropic-version'],
        undefined,
        'Chat unexpectedly received Anthropic headers'
      )
      return
    }
    assert.equal(headers['x-api-key'], MODEL_API_KEY, 'Anthropic x-api-key was not forwarded')
    assert.equal(
      headers['anthropic-version'],
      '2023-06-01',
      'Anthropic protocol version was not forwarded'
    )
    assert.ok(
      typeof body.system === 'string' && body.system.length > 0,
      'Anthropic system instructions were not preserved'
    )
    assert.ok(body.max_tokens > 0, 'Anthropic max_tokens was not populated')
  }

  assertLocalConversation(model, body, { includes, excludes }) {
    const serialized = JSON.stringify(body)
    for (const value of includes) {
      assert.ok(serialized.includes(value), `${model.protocol} request lost history: ${value}`)
    }
    for (const value of excludes) {
      assert.equal(
        serialized.includes(value),
        false,
        `${model.protocol} request leaked future history: ${value}`
      )
    }
  }

  assertLocalApplyPatchTool(model, body) {
    const tools = Array.isArray(body.tools) ? body.tools : []
    const tool = tools.find(
      candidate => (candidate?.name ?? candidate?.function?.name) === 'apply_patch'
    )
    assert.ok(tool, `${model.protocol} did not receive apply_patch`)
    const names = tools
      .map(candidate => candidate?.name ?? candidate?.function?.name)
      .filter(Boolean)
    assert.ok(
      names.includes('shell_command') || names.includes('exec_command'),
      `${model.protocol} did not receive a shell tool: ${names.join(', ')}`
    )
    if (model.protocol === 'responses') {
      assert.equal(tool.type, 'function', 'Responses apply_patch was not converted to function')
      const description = tool.description ?? ''
      this.assertApplyPatchOutputContract(model, description)
      assert.deepEqual(
        tool.parameters,
        {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
        'Responses apply_patch wrapper schema was not preserved'
      )
      return
    }
    if (model.protocol === 'chat') {
      assert.equal(tool.type, 'function', 'Chat apply_patch was not converted to function')
      const description = tool.function?.description ?? ''
      assert.match(
        description,
        /Original tool definition:[\s\S]*"syntax":"lark"/,
        'Chat apply_patch lost its custom grammar'
      )
      this.assertApplyPatchOutputContract(model, description)
      assert.deepEqual(
        tool.function?.parameters,
        {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: ['input'],
          additionalProperties: false,
        },
        'Chat apply_patch wrapper schema was not preserved'
      )
      return
    }
    assert.ok(tool.input_schema, 'Anthropic apply_patch input_schema was missing')
    const description = tool.description ?? ''
    assert.match(
      description,
      /Original tool definition:[\s\S]*"syntax":"lark"/,
      'Anthropic apply_patch lost its custom grammar'
    )
    this.assertApplyPatchOutputContract(model, description)
    assert.deepEqual(
      tool.input_schema,
      {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: CUSTOM_TOOL_INPUT_DESCRIPTION,
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
      'Anthropic apply_patch wrapper schema was not preserved'
    )
  }

  assertLocalNamespaceTools(model, body) {
    const tools = Array.isArray(body.tools) ? body.tools : []
    const names = tools
      .map(candidate => candidate?.name ?? candidate?.function?.name)
      .filter(Boolean)

    assert.ok(
      names.some(name => name === 'browser_open' || name.endsWith('__browser_open')),
      `${model.protocol} did not flatten the wework_browser namespace: ${names.join(', ')}`
    )
    assert.equal(
      names.includes('wework_browser'),
      false,
      `${model.protocol} exposed the namespace container as a callable function`
    )
  }

  assertLocalNamespaceToolOutput(model, body) {
    const serialized = JSON.stringify(body)
    assert.equal(
      serialized.includes('unsupported function call: browser_open'),
      false,
      `${model.protocol} did not restore the wework_browser namespace on the tool call`
    )

    if (model.protocol === 'responses') {
      const call = body.input?.find(
        item =>
          item?.type === 'function_call' &&
          (item?.name === 'browser_open' || item?.name?.endsWith('__browser_open'))
      )
      assert.ok(call, 'Responses lost the flattened browser_open call history')
      assert.ok(
        body.input?.some(
          item => item?.type === 'function_call_output' && item?.call_id === call?.call_id
        ),
        'Responses lost the namespaced browser_open result'
      )
      return
    }
    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(
          candidate =>
            candidate?.function?.name === 'browser_open' ||
            candidate?.function?.name?.endsWith('__browser_open')
        )
      assert.ok(call, 'Chat lost the flattened browser_open call history')
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        'Chat lost the namespaced browser_open result'
      )
      return
    }

    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(
      block =>
        block?.type === 'tool_use' &&
        (block?.name === 'browser_open' || block?.name?.endsWith('__browser_open'))
    )
    assert.ok(call, 'Anthropic lost the flattened browser_open call history')
    assert.ok(
      blocks.some(block => block?.type === 'tool_result' && block?.tool_use_id === call?.id),
      'Anthropic lost the namespaced browser_open result'
    )
  }

  assertApplyPatchOutputContract(model, description) {
    for (const instruction of [
      'Critical apply_patch input contract:',
      'exactly `*** Begin Patch\\n`',
      'with no blank line',
      'Do not include Markdown code fences',
      'every added-file content line must start with `+`',
    ]) {
      assert.ok(
        description.includes(instruction),
        `${model.protocol} apply_patch wrapper omitted instruction: ${instruction}`
      )
    }
  }

  assertLocalToolOutput(model, body) {
    const patch = localProtocolPatch(model)
    if (model.protocol === 'responses') {
      const output = body.input?.find(item => item?.type === 'function_call_output')
      assert.equal(
        output?.call_id,
        'local-responses-tool',
        'Responses lost the apply_patch call ID'
      )
      assert.ok(output?.output, 'Responses lost the apply_patch output')
      return
    }
    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'apply_patch')
      assert.deepEqual(
        JSON.parse(call?.function?.arguments ?? '{}'),
        { input: patch },
        'Chat changed the wrapped apply_patch input'
      )
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        'Chat lost the function tool result or call ID'
      )
      return
    }
    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(block => block?.type === 'tool_use' && block?.name === 'apply_patch')
    assert.deepEqual(call?.input, { input: patch }, 'Anthropic changed the apply_patch input')
    assert.ok(
      blocks.some(block => block?.type === 'tool_result' && block?.tool_use_id === call?.id),
      'Anthropic lost the tool_result block or tool_use_id'
    )
  }

  assertModelSwitchHistory(model, body) {
    const serialized = JSON.stringify(body)
    assert.ok(
      !serialized.includes(LOCAL_MODEL_SWITCH_INVALID_CALL_ID),
      `${model.protocol} received the original invalid provider tool call ID`
    )

    if (model.protocol === 'responses') {
      const items = Array.isArray(body.input) ? body.input : []
      const call = items.find(
        item => item?.type === 'function_call' && item?.name === 'exec_command'
      )
      const output = items.find(item => item?.type === 'function_call_output')

      assert.ok(call, 'Responses lost the converted exec_command call history')
      assert.ok(output, 'Responses lost the converted exec_command output history')
      if (call.id != null) {
        assert.match(call.id, /^[A-Za-z0-9_-]+$/, 'Responses received an invalid item ID')
      }
      assert.match(call.call_id, /^[A-Za-z0-9_-]+$/, 'Responses received an invalid call ID')
      assert.equal(
        output.call_id,
        call.call_id,
        'Responses broke the cross-protocol tool call/output association'
      )
      return
    }

    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'exec_command')
      const output = body.messages?.find(
        message => message?.role === 'tool' && message?.tool_call_id === call?.id
      )

      assert.ok(call, 'Chat lost the converted exec_command call history')
      assert.ok(output, 'Chat lost the converted exec_command output history')
      assert.match(call.id, /^[A-Za-z0-9_-]+$/, 'Chat received an invalid tool call ID')
      assert.deepEqual(
        JSON.parse(call.function?.arguments ?? '{}'),
        { cmd: localModelSwitchCommand() },
        'Chat changed the exec_command arguments during protocol conversion'
      )
      return
    }

    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(block => block?.type === 'tool_use' && block?.name === 'exec_command')
    const output = blocks.find(
      block => block?.type === 'tool_result' && block?.tool_use_id === call?.id
    )

    assert.ok(call, 'Anthropic lost the converted exec_command call history')
    assert.ok(output, 'Anthropic lost the converted exec_command output history')
    assert.match(call.id, /^[A-Za-z0-9_-]+$/, 'Anthropic received an invalid tool use ID')
    assert.deepEqual(
      call.input,
      { cmd: localModelSwitchCommand() },
      'Anthropic changed the exec_command input during protocol conversion'
    )
  }

  hasModelSwitchHistory(model, body) {
    if (model.protocol === 'responses') {
      return body.input?.some(
        item => item?.type === 'function_call' && item?.name === 'exec_command'
      )
    }
    if (model.protocol === 'chat') {
      return body.messages?.some(message =>
        message?.tool_calls?.some(call => call?.function?.name === 'exec_command')
      )
    }
    return body.messages?.some(message =>
      message?.content?.some(block => block?.type === 'tool_use' && block?.name === 'exec_command')
    )
  }

  writeModelSwitchToolCall(response, model) {
    const toolInput = { cmd: localModelSwitchCommand() }
    if (model.protocol === 'responses') {
      const responseId = 'responses-model-switch-tool'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall(LOCAL_MODEL_SWITCH_INVALID_CALL_ID, 'exec_command', toolInput),
        responseCompleted(responseId),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(
        response,
        toolInput,
        LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
        'exec_command'
      )
      return
    }
    this.writeAnthropicToolCall(
      response,
      toolInput,
      LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
      'exec_command'
    )
  }

  writeLocalError(response, model, message) {
    if (model.protocol === 'responses') {
      const responseId = 'responses-model-switch-error'
      this.writeSse(response, [responseCreated(responseId), responseFailed(responseId, message)])
      return
    }
    if (model.protocol === 'chat') {
      json(response, 400, {
        error: { type: 'invalid_request_error', message },
      })
      return
    }
    this.writeAnthropicError(response, message)
  }

  writeLocalToolCall(response, model, patch) {
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-tool`
      this.writeSse(response, [
        responseCreated(id),
        ...functionCall(id, 'apply_patch', { input: patch }),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, patch)
      return
    }
    this.writeAnthropicToolCall(response, patch)
  }

  writeLocalToolSearchCall(response, model, search) {
    const callId = `${model.protocol}-local-browser-search`
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-browser-search`
      this.writeSse(response, [
        responseCreated(id),
        ...toolSearchResponseEvents(callId, search),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, search.arguments, callId, search.name)
      return
    }
    this.writeAnthropicToolCall(response, search.arguments, callId, search.name)
  }

  writeLocalNamespaceToolCall(response, model, tool) {
    const callId = `${model.protocol}-local-browser-open`
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-browser-open`
      this.writeSse(response, [
        responseCreated(id),
        ...functionCall(callId, tool.name, tool.arguments),
        responseCompleted(id),
      ])
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, tool.arguments, callId, tool.name)
      return
    }
    this.writeAnthropicToolCall(response, tool.arguments, callId, tool.name)
  }

  writeLocalAssistantMessage(response, model, text) {
    if (model.protocol === 'responses') {
      const id = `local-${model.protocol}-message`
      const events = [responseCreated(id)]
      if (text) events.push(assistantMessage(text))
      events.push(responseCompleted(id))
      this.writeSse(response, events)
      return
    }
    if (model.protocol === 'chat') {
      this.writeChatMessage(response, text)
      return
    }
    this.writeAnthropicMessage(response, text)
  }

  writeChatToolCall(
    response,
    toolInput,
    callId = 'chat-local-apply-patch',
    toolName = 'apply_patch',
    assistantText = ''
  ) {
    const argumentsValue = JSON.stringify(
      toolName === 'apply_patch' ? { input: toolInput } : toolInput
    )
    const splitAt = Math.max(1, Math.floor(argumentsValue.length / 2))
    const chunks = []
    if (assistantText) {
      chunks.push({
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: assistantText,
            },
            finish_reason: null,
          },
        ],
      })
    }
    chunks.push(
      {
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: argumentsValue.slice(0, splitAt),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chat-local-tool',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  function: {
                    name: toolName,
                    arguments: argumentsValue.slice(splitAt),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }
    )
    this.writeRawSse(
      response,
      `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
    )
  }

  writeChatMessage(response, text) {
    const chunk = {
      id: 'chat-local-message',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }
    this.writeRawSse(response, `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
  }

  writeAnthropicToolCall(
    response,
    toolInput,
    callId = 'anthropic-local-apply-patch',
    toolName = 'apply_patch',
    assistantText = ''
  ) {
    const input = JSON.stringify(toolName === 'apply_patch' ? { input: toolInput } : toolInput)
    const toolIndex = assistantText ? 1 : 0
    const events = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'anthropic-local-tool',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'desktop-e2e-anthropic-model',
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
    ]
    if (assistantText) {
      events.push(
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: assistantText },
          },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }]
      )
    }
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: callId,
            name: toolName,
            input: {},
          },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: toolIndex,
          delta: { type: 'input_json_delta', partial_json: input },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: toolIndex }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ['message_stop', { type: 'message_stop' }]
    )
    this.writeAnthropicSse(response, events)
  }

  writeAnthropicError(response, message) {
    this.writeAnthropicSse(response, [
      [
        'error',
        {
          type: 'error',
          error: { type: 'invalid_request_error', message },
        },
      ],
    ])
  }

  writeAnthropicMessage(response, text) {
    this.writeAnthropicSse(response, [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'anthropic-local-message',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'desktop-e2e-anthropic-model',
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: text ? 1 : 0 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
  }

  writeAnthropicSse(response, events) {
    this.writeRawSse(
      response,
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    )
  }

  writeRawSse(response, body) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(body)
  }

  writeSse(response, events) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(createSse(events))
  }

  async writeStreamingMarkdown(response, responseId, text) {
    const stream = streamingTextEvents(responseId, text)
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.write(createSse(stream.start))
    let offset = 0
    for (const delta of stream.chunks) {
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta,
            offset,
          },
        ])
      )
      offset += [...delta].length
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
    }
    response.end(createSse(stream.finish))
  }
}

export { DesktopE2EServer }
