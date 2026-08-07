import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import {
  access,
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DESKTOP_CHECKPOINTS, PLUGIN_SEGMENTS } from './checkpoints.mjs'
import { loadDesktopScenario } from './scenario-loader.mjs'
import { stopProcess, stopProcessGroup } from './process-lifecycle.mjs'

const DESKTOP_READY_TIMEOUT_MS = 60_000
const WORKBENCH_READY_TIMEOUT_MS = 180_000
const DEFAULT_STEP_TIMEOUT_MS = readPositiveTimeout(
  process.env.WEWORK_E2E_STEP_TIMEOUT_MS,
  10_000,
  'WEWORK_E2E_STEP_TIMEOUT_MS'
)
const DESKTOP_MODEL_SERVER_PORT = readOptionalPort(
  process.env.WEWORK_E2E_MODEL_SERVER_PORT,
  'WEWORK_E2E_MODEL_SERVER_PORT'
)
const DESKTOP_CONTROL_SERVER_PORT = readOptionalPort(
  process.env.WEWORK_E2E_CONTROL_SERVER_PORT,
  'WEWORK_E2E_CONTROL_SERVER_PORT'
)
const MODEL_PROTOCOL_MATRIX_TIMEOUT_MS = 10_000
const COMPOSER_READY_STABILITY_MS = 750
const DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS
const DESKTOP_CONTROL_RESULT_GRACE_MS = 5_000
const QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS = 120_000

function readPositiveTimeout(value, fallback, name) {
  if (value === undefined) return fallback
  const timeoutMs = Number(value)
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    `${name} must be a positive number of milliseconds`
  )
  return timeoutMs
}

function readOptionalPort(value, name) {
  if (value === undefined) return 0
  const port = Number(value)
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, `${name} must be a TCP port`)
  return port
}
const TASK_PROMPT = 'WEWORK_DESKTOP_E2E_TASK: create the requested verification file.'
const COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_COMPLETE'
const FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_FOLLOW_UP: confirm the completed task.'
const FOLLOW_UP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FOLLOW_UP_COMPLETE'
const RUNNING_FORK_FOLLOW_UP_PROMPT =
  'WEWORK_DESKTOP_E2E_RUNNING_FORK: keep streaming while the first turn is forked.'
const RUNNING_FORK_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RUNNING_FORK_COMPLETE'
const FORK_FOLLOW_UP_PROMPT = 'WEWORK_DESKTOP_E2E_FORK_FOLLOW_UP: continue only in the forked task.'
const FORK_FOLLOW_UP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FORK_FOLLOW_UP_COMPLETE'
const FORK_ENCRYPTED_CONTENT = 'gAAAA-wework-desktop-e2e-fork-context'
const REQUEST_USER_INPUT_PROMPT =
  'WEWORK_DESKTOP_E2E_REQUEST_INPUT: ask which implementation direction to use.'
const REQUEST_USER_INPUT_QUESTION = 'Which implementation direction should be used?'
const REQUEST_USER_INPUT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_REQUEST_INPUT_COMPLETE'
const TASK_PLAN_PROMPT =
  'WEWORK_DESKTOP_E2E_TASK_PLAN: publish a task plan and finish after the task is backgrounded.'
const TASK_PLAN_STEP = 'Verify the background task plan remains visible'
const SEND_MODE_DRAFT = 'WEWORK_DESKTOP_E2E_SEND_MODE_DRAFT'
const QUEUED_FOLLOW_UP = 'WEWORK_DESKTOP_E2E_QUEUED_FOLLOW_UP'
const BACKGROUND_GUIDANCE = 'WEWORK_DESKTOP_E2E_BACKGROUND_GUIDANCE'
const GUIDANCE_SCROLL_PROMPT =
  'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL: create a long completed conversation.'
const GUIDANCE_SCROLL_ACTIVE_PROMPT =
  'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_ACTIVE: keep this turn active for guidance.'
const GUIDANCE_SCROLL_RESPONSE = [
  'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_RESPONSE',
  ...Array.from(
    { length: 32 },
    (_, index) =>
      `Guidance scroll setup paragraph ${String(index + 1).padStart(2, '0')}. ${'Scrollable setup content '.repeat(8)}`
  ),
].join('\n\n')
const GUIDANCE_SCROLL_MESSAGE = 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_MESSAGE'
const GUIDANCE_SCROLL_PRE_TOOL_TEXT = 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_PRE_TOOL_TEXT'
const GUIDANCE_SCROLL_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_COMPLETE'
const QUEUE_DIRECT_INITIAL = 'WEWORK_DESKTOP_E2E_QUEUE_DIRECT_INITIAL'
const QUEUE_DIRECT_FIRST = 'WEWORK_DESKTOP_E2E_QUEUE_DIRECT_FIRST'
const QUEUE_DIRECT_SECOND = 'WEWORK_DESKTOP_E2E_QUEUE_DIRECT_SECOND'
const QUEUE_DIRECT_THIRD = 'WEWORK_DESKTOP_E2E_QUEUE_DIRECT_THIRD'
const QUEUE_PRESERVE_INITIAL = 'WEWORK_DESKTOP_E2E_QUEUE_PRESERVE_INITIAL'
const QUEUE_PRESERVE_QUEUED = 'WEWORK_DESKTOP_E2E_QUEUE_PRESERVE_QUEUED'
const QUEUE_PRESERVE_MANUAL = 'WEWORK_DESKTOP_E2E_QUEUE_PRESERVE_MANUAL'
const QUEUE_CLEAR_INITIAL = 'WEWORK_DESKTOP_E2E_QUEUE_CLEAR_INITIAL'
const QUEUE_CLEAR_QUEUED = 'WEWORK_DESKTOP_E2E_QUEUE_CLEAR_QUEUED'
const QUEUE_CLEAR_MANUAL = 'WEWORK_DESKTOP_E2E_QUEUE_CLEAR_MANUAL'
const QUEUE_MANAGEMENT_COMPLETION_PREFIX = 'WEWORK_DESKTOP_E2E_QUEUE_COMPLETE'
const UNSENT_BLANK_TASK_DRAFT = 'WEWORK_DESKTOP_E2E_UNSENT_BLANK_TASK_DRAFT'
const UNSENT_FIRST_TASK_DRAFT = 'WEWORK_DESKTOP_E2E_UNSENT_FIRST_TASK_DRAFT'
const UNSENT_SECOND_TASK_DRAFT = 'WEWORK_DESKTOP_E2E_UNSENT_SECOND_TASK_DRAFT'
const WINDOW_LIFECYCLE_PROMPT =
  'WEWORK_DESKTOP_E2E_WINDOW_LIFECYCLE: keep this response running until released.'
const WINDOW_LIFECYCLE_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_WINDOW_LIFECYCLE_COMPLETE'
const BACKGROUND_COMPLETION_RESTORE_PROMPT =
  'WEWORK_DESKTOP_E2E_BACKGROUND_COMPLETION_RESTORE: complete after another conversation opens.'
const BACKGROUND_COMPLETION_RESTORE_TEXT =
  'WEWORK_DESKTOP_E2E_BACKGROUND_COMPLETION_RESTORE_COMPLETE'
const BACKGROUND_FOLLOW_UP_RESTORE_PROMPT =
  'WEWORK_DESKTOP_E2E_BACKGROUND_FOLLOW_UP_RESTORE: finish while another conversation is open.'
const BACKGROUND_FOLLOW_UP_RESTORE_TEXT = 'WEWORK_DESKTOP_E2E_BACKGROUND_FOLLOW_UP_RESTORE_COMPLETE'
const WINDOW_LIFECYCLE_SCROLL_MARKER = 'WEWORK_DESKTOP_E2E_SCROLL_POSITION_MARKER'
const GOAL_IDLE_PROMPT =
  'WEWORK_DESKTOP_E2E_GOAL_IDLE: create an active goal and keep it active for one continuation.'
const GOAL_IDLE_INITIAL_TEXT = 'WEWORK_DESKTOP_E2E_GOAL_IDLE_INITIAL_COMPLETE'
const GOAL_IDLE_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_GOAL_IDLE_COMPLETE'
const GOAL_RESTART_PROMPT =
  'WEWORK_DESKTOP_E2E_GOAL_RESTART: keep this active goal running until Wework restarts.'
const GOAL_RESTART_INITIAL_TEXT = 'WEWORK_DESKTOP_E2E_GOAL_RESTART_INITIAL_COMPLETE'
const GOAL_RESTART_RESUME_PROMPT = 'WEWORK_DESKTOP_E2E_GOAL_RESTART_RESUME'
const GOAL_RESTART_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_GOAL_RESTART_COMPLETE'
const SUPERVISOR_PROMPT =
  'WEWORK_DESKTOP_E2E_SUPERVISOR: complete this task so supervision can inspect it.'
const SUPERVISOR_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_SUPERVISOR_COMPLETE'
const SUPERVISOR_PRINCIPLES =
  'Flag material goal drift and provide the smallest directly actionable correction.'
const SUPERVISOR_CORRECTION =
  'WEWORK_DESKTOP_E2E_SUPERVISOR_CORRECTION: explicitly confirm the original constraint.'
const SUPERVISOR_CORRECTION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_SUPERVISOR_CORRECTION_COMPLETE'
const WINDOW_LIFECYCLE_COMPLETION_RESPONSE = [
  WINDOW_LIFECYCLE_COMPLETION_TEXT,
  ...Array.from({ length: 24 }, (_, index) =>
    index === 12
      ? WINDOW_LIFECYCLE_SCROLL_MARKER
      : `Persisted transcript verification paragraph ${String(index + 1).padStart(2, '0')}. ${'Scrollable content '.repeat(8)}`
  ),
].join('\n\n')
const CHECKPOINT_TASK_PROMPT =
  'WEWORK_DESKTOP_E2E_CHECKPOINT_TASK: create a completed task for downstream checkpoints.'
const CHECKPOINT_TASK_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CHECKPOINT_TASK_COMPLETE'
const FILE_PANEL_ANCHOR_PROMPT =
  'WEWORK_DESKTOP_E2E_FILE_PANEL_ANCHOR: create a long response with a file link in the middle.'
const FILE_PANEL_ANCHOR_MARKER = 'WEWORK_DESKTOP_E2E_FILE_PANEL_ANCHOR_MARKER'
const FILE_PREVIEW_RESTORE_MARKER = 'WEWORK_DESKTOP_E2E_FILE_PREVIEW_RESTORED'
const REVIEW_RESTORE_MARKER = 'WEWORK_DESKTOP_E2E_REVIEW_RESTORED'
const FILE_PANEL_ANCHOR_RESPONSE = [
  'WEWORK_DESKTOP_E2E_FILE_PANEL_ANCHOR_RESPONSE',
  ...Array.from({ length: 30 }, (_, index) =>
    index === 14
      ? `${FILE_PANEL_ANCHOR_MARKER}: inspect [README.md](README.md:1) without moving this paragraph.`
      : `File panel anchor paragraph ${String(index + 1).padStart(2, '0')}. ${'Scrollable anchor content '.repeat(8)}`
  ),
].join('\n\n')
const TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX = 'WEWORK_DESKTOP_E2E_TURN_NAVIGATION'
const TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX = 'WEWORK_DESKTOP_E2E_TURN_NAVIGATION_COMPLETE'
const TURN_NAVIGATION_REGRESSION_TURN_COUNT = 30
const TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN = 6
const CANCELLATION_PROMPT = 'WEWORK_DESKTOP_E2E_CANCEL: wait until the response is cancelled.'
const CANCELLATION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CANCEL_COMPLETE'
const RETRY_PROMPT = 'WEWORK_DESKTOP_E2E_RETRY: fail once and then succeed after retry.'
const RETRY_FAILURE_TEXT = 'WEWORK_DESKTOP_E2E_RETRY_FAILURE'
const RETRY_CODEX_ERROR_TEXT = "Codex ran out of room in the model's context window."
const RETRY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RETRY_COMPLETE'
const RATE_LIMIT_PROMPT = 'WEWORK_DESKTOP_E2E_RATE_LIMIT: recover from one model 429.'
const RATE_LIMIT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RATE_LIMIT_COMPLETE'
const ANTHROPIC_EMPTY_PROMPT =
  'WEWORK_DESKTOP_E2E_ANTHROPIC_EMPTY: recover when Kimi reports tokens without output.'
const ANTHROPIC_EMPTY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_ANTHROPIC_EMPTY_COMPLETE'
const RECONNECT_PROMPT = 'WEWORK_DESKTOP_E2E_RECONNECT: recover after the stream disconnects.'
const RECONNECT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_RECONNECT_COMPLETE'
const MEMORY_PROMPT = 'WEWORK_DESKTOP_E2E_MEMORY: run a tool and stream the report.'
const MEMORY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_MEMORY_COMPLETE'
const CONCURRENT_MEMORY_TASK_COUNT = 10
const CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB = Number(
  process.env.WEWORK_E2E_CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB ?? 800 * 1024
)
const MEMORY_SAMPLE_INTERVAL_MS = 500
const MEMORY_MAX_PEAK_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB ?? 384 * 1024
)
const MEMORY_MAX_SETTLED_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB ?? 232 * 1024
)
const MEMORY_MAX_SETTLED_DOM_NODE_COUNT = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_SETTLED_DOM_NODES ?? 900
)
const MEMORY_MIN_BASELINE_SAMPLES = 5
const MEMORY_MAX_BASELINE_SAMPLES = 15
const MEMORY_MIN_SETTLED_SAMPLES = 5
const MEMORY_MAX_SETTLED_SAMPLES = 15
const MEMORY_MAX_SAMPLE_RANGE_KIB = 16 * 1024
const MEMORY_SAMPLE_WINDOW_SIZE = 3
const ARTIFACT_NAME = 'wework-e2e-result.txt'
const ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_TOOL'
const IMAGE_ARTIFACT_NAME = 'wework-e2e-image.png'
const VIEW_IMAGE_PROMPT = 'WEWORK_DESKTOP_E2E_VIEW_IMAGE: inspect the verification image.'
const VIEW_IMAGE_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_VIEW_IMAGE_COMPLETE'
const VISION_SIDECAR_PROMPT =
  'WEWORK_DESKTOP_E2E_VISION_SIDECAR: describe the attached verification image.'
const VISION_SIDECAR_DESCRIPTION = 'The verification image is a solid red square.'
const VISION_SIDECAR_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_VISION_SIDECAR_COMPLETE'
const LOCAL_VISION_SIDECAR_CASE = {
  source: 'local',
  mainOptionId: 'local-model:desktop-e2e-vision-main',
  mainLabel: 'Desktop E2E DeepSeek Pro Vision Main',
  mainModelId: 'deepseek-v4-pro',
  sidecarModelId: 'kimi-k3',
}
const CLOUD_VISION_SIDECAR_CASE = {
  source: 'cloud',
  mainOptionId: 'desktop-e2e-cloud-vision-main',
  mainLabel: 'Desktop E2E Cloud Vision Main',
  mainModelId: 'desktop-e2e-cloud-vision-main-upstream',
  sidecarModelId: 'desktop-e2e-cloud-vision-sidecar-upstream',
}
const IMAGE_ARTIFACT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'
const GIT_SEED_NAME = 'README.md'
const GIT_SEED_CONTENT = '# Desktop E2E workspace\n'
const MODEL_API_KEY = 'wework-e2e-test-key'
const MODEL_PROVIDER_ID = 'wework-e2e'
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Put only the tool input in this field, preserve every character exactly, and follow the original definition embedded in the function description. Do not add Markdown fences or explanatory text.'
const DEFAULT_MODEL_ID = 'gpt-5.6-luna'
const DEFAULT_MODEL_LABEL = 'GPT 5.6 Luna'
const LOCAL_MODEL_CASES = [
  {
    protocol: 'responses',
    optionId: 'local-model:desktop-e2e-responses',
    label: 'Desktop E2E Responses',
    modelId: 'desktop-e2e-responses-model',
  },
  {
    protocol: 'chat',
    optionId: 'local-model:desktop-e2e-chat',
    label: 'Desktop E2E Chat',
    modelId: 'desktop-e2e-chat-model',
  },
  {
    protocol: 'anthropic',
    optionId: 'local-model:desktop-e2e-anthropic',
    label: 'Desktop E2E Anthropic',
    modelId: 'desktop-e2e-anthropic-model',
  },
]
const MODEL_PROTOCOLS = ['responses', 'chat', 'anthropic']
const CLOUD_MODEL_CASES = MODEL_PROTOCOLS.map(protocol => ({
  source: 'cloud',
  protocol,
  optionId: `desktop-e2e-cloud-${protocol}`,
  label: protocol === 'chat' ? 'moonshot-kimi-k3' : `desktop-e2e-cloud-${protocol}`,
  modelId: protocol === 'chat' ? 'moonshot-kimi-k3' : `desktop-e2e-cloud-${protocol}-upstream`,
}))
const MODEL_PROTOCOL_MATRIX_CASES = [
  ...LOCAL_MODEL_CASES.map(model => ({ ...model, source: 'local' })),
  ...MODEL_PROTOCOLS.map(protocol => ({
    source: 'codex',
    protocol,
    optionId: DEFAULT_MODEL_ID,
    label: DEFAULT_MODEL_LABEL,
    modelId: DEFAULT_MODEL_ID,
  })),
  ...CLOUD_MODEL_CASES,
]
const LOCAL_MODEL_SWITCH_CASES = MODEL_PROTOCOLS.flatMap(sourceProtocol =>
  MODEL_PROTOCOLS.filter(targetProtocol => targetProtocol !== sourceProtocol).map(
    targetProtocol => ({
      sourceProtocol,
      targetProtocol,
      id: `${sourceProtocol}-to-${targetProtocol}`,
    })
  )
)
const LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES = MODEL_PROTOCOL_MATRIX_CASES.map(model => ({
  ...model,
  execution: 'local',
}))
const CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES = MODEL_PROTOCOL_MATRIX_CASES.map(model => ({
  ...model,
  execution: 'cloud',
}))
const LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES = LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.filter(
  model => model.source === 'local'
)
const MIXED_TOOL_TURN_MODEL_PROTOCOL_MATRIX_CASES = LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES.filter(
  model => model.protocol === 'chat' || model.protocol === 'anthropic'
)
const LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES =
  LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.filter(model => model.source !== 'local')
const MODEL_PROTOCOL_MATRIX_TOTAL = MODEL_PROTOCOL_MATRIX_CASES.length * 2
const MODEL_PROTOCOL_MATRIX_TEXT_PREFIX = 'WEWORK_MODEL_PROTOCOL_MATRIX_TEXT'
const MODEL_PROTOCOL_MATRIX_TOOL_PREFIX = 'WEWORK_MODEL_PROTOCOL_MATRIX_TOOL'
const LOCAL_MODEL_SWITCH_INITIAL_PROMPT =
  'WEWORK_LOCAL_MODEL_SWITCH_INITIAL: establish context with the first custom model.'
const LOCAL_MODEL_SWITCH_INITIAL_COMPLETE = 'WEWORK_LOCAL_MODEL_SWITCH_INITIAL_COMPLETE'
const LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT =
  'WEWORK_LOCAL_MODEL_SWITCH_FOLLOW_UP: continue this conversation with the second custom model.'
const LOCAL_MODEL_SWITCH_COMPLETE = 'WEWORK_LOCAL_MODEL_SWITCH_COMPLETE'
const LOCAL_MODEL_SWITCH_INVALID_CALL_ID = 'functions.exec_command:0'
const LOCAL_MODEL_SWITCH_ARTIFACT = 'wework-model-switch-protocol.txt'
const LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT = 'WEWORK_MODEL_SWITCH_PROTOCOL_EXEC_COMMAND'
const PROVIDER_SWITCH_LUNA_OPTION_ID = 'local-model:desktop-e2e-luna-overseas'
const PROVIDER_SWITCH_LUNA_LABEL = 'GPT 5.6 Luna (海外)'
const PROVIDER_SWITCH_LUNA_MODEL_ID = 'gpt-5.6-luna'
// The local E2E Codex catalog is classified as third-party (custom provider), so
// the official option is served from the cloud model catalog with a canonical
// model id that does not collide with the local Codex catalog.
const PROVIDER_SWITCH_OFFICIAL_OPTION_ID = 'gpt-5.5'
const PROVIDER_SWITCH_OFFICIAL_LABEL = 'GPT 5.5'
const PROVIDER_SWITCH_OFFICIAL_MODEL_ID = 'gpt-5.5'
const PROVIDER_SWITCH_OFFICIAL_MODEL_LABEL = 'GPT 5.5'
const PROVIDER_SWITCH_PROMPT =
  'WEWORK_DESKTOP_E2E_PROVIDER_SWITCH: fail on Luna, then retry this turn with official GPT.'
const PROVIDER_SWITCH_FAILURE = 'WEWORK_DESKTOP_E2E_LUNA_INTENTIONAL_FAILURE'
const PROVIDER_SWITCH_COMPLETION = 'WEWORK_DESKTOP_E2E_PROVIDER_SWITCH_GPT_COMPLETE'
const BLOCKED_CLOUD_MODEL_PATH = '/api/models/unified'
const TELEMETRY_CAPTURE_PATH = '/e/'
const TELEMETRY_TEST_PROJECT_KEY = 'wework-desktop-e2e'
const TELEMETRY_SAFE_PROPERTY_KEYS = new Set([
  '$device_id',
  '$geoip_disable',
  '$lib',
  '$lib_version',
  '$process_person_profile',
  '$session_id',
  '$window_id',
  'app_version',
  'arch',
  'distinct_id',
  'feature',
  'locale',
  'os',
  'release_channel',
  'runtime_mode',
  'surface',
  'telemetry_session_id',
  'token',
])
const TELEMETRY_FORBIDDEN_PROPERTY_PATTERN =
  /(authorization|code|content|credential|email|file|message|path|prompt|repository|response|task_id|token|url|user_id|workspace)/i
const CLOUD_PUBLIC_MODEL_NAME = 'desktop-e2e-public-model'
const CLOUD_PUBLIC_MODEL_LABEL = 'Desktop E2E Public Model'
const CLOUD_DEVICE_ID = 'wework-e2e-cloud-device'
const FRESH_CHAT_PROMPT = 'WEWORK_DESKTOP_E2E_FRESH_CHAT: confirm this is a new conversation.'
const FRESH_CHAT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_FRESH_CHAT_COMPLETE'
const CONVERSATION_SWITCH_RACE_PROMPT =
  'WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_1: keep a second conversation running during a rapid switch.'
const SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET = 160
const COMPOSER_PROJECT_NAME = 'Composer Flow Project'
const ATTACHMENT_ONLY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_ATTACHMENT_ONLY_COMPLETE'
const ATTACHMENT_ONLY_FILENAME = 'same-name-attachment.png'
const PASTED_ZIP_FILENAME = 'pasted-feedback.zip'
const PASTED_ZIP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_PASTED_ZIP_COMPLETE'
const PASTED_ZIP_BASE64 = Buffer.from('PK\x03\x04WEWORK_E2E_ZIP').toString('base64')
const PASTED_PATH_FOLDER_NAME = 'pasted-context-folder'
const PASTED_PATH_FILE_NAME = 'pasted-context.md'
const PASTED_PATH_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_PASTED_PATHS_COMPLETE'
const DROPPED_PATH_FOLDER_NAME = 'dropped-context-folder'
const DROPPED_PATH_FILE_NAME = 'dropped-context.md'
const DROPPED_PATH_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_DROPPED_PATHS_COMPLETE'
const TOOL_BLOCK_ORDER_PROMPT =
  'WEWORK_DESKTOP_E2E_TOOL_BLOCK_ORDER: run the four requested tools in order.'
const TOOL_BLOCK_ORDER_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_TOOL_BLOCK_ORDER_COMPLETE'
const EARLIER_TOOL_BLOCK_ID = 'wework-e2e-tool-earlier'
const NODE_REPL_TOOL_SEARCH_ID = 'wework-e2e-search-node-repl'
const NODE_REPL_TOOL_BLOCK_ID = 'wework-e2e-tool-node-repl'
const GENERIC_MCP_TOOL_SEARCH_ID = 'wework-e2e-search-generic-mcp'
const GENERIC_MCP_TOOL_BLOCK_ID = 'wework-e2e-tool-generic-mcp'
const LATER_TOOL_BLOCK_ID = 'wework-e2e-tool-later'
const SIDE_CHAT_PROMPT = 'WEWORK_DESKTOP_E2E_SIDE_CHAT: verify isolated attachments.'
const SIDE_CHAT_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_COMPLETE'
const SIDE_CHAT_FILENAME = 'side-chat-only.png'
const SIDE_CHAT_QUEUE_INITIAL = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_QUEUE_INITIAL'
const SIDE_CHAT_QUEUE_FOLLOW_UP = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_QUEUE_FOLLOW_UP'
const CLOUD_TASK_PROMPT =
  'WEWORK_DESKTOP_E2E_CLOUD_TASK: create the requested cloud verification file.'
const CLOUD_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CLOUD_COMPLETE'
const CLOUD_FOLLOW_UP_PROMPT =
  'WEWORK_DESKTOP_E2E_CLOUD_FOLLOW_UP: confirm the cloud task remains available.'
const CLOUD_FOLLOW_UP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CLOUD_FOLLOW_UP_COMPLETE'
const CLOUD_ARTIFACT_NAME = 'wework-cloud-e2e-result.txt'
const CLOUD_ARTIFACT_CONTENT = 'CODEX_EXECUTED_REAL_CLOUD_TOOL'
const ACTIVE_WORKBENCH_SELECTOR = '[data-testid="desktop-workbench-main"]'
const ACTIVE_COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ACTIVE_SEND_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
const ACTIVE_SWITCH_MODEL_RETRY_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-switch-model-retry"]`
const MACOS_LAUNCH_SERVICES_REGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const REQUEST_INPUT_ONLY = process.env.WEWORK_DESKTOP_E2E_REQUEST_INPUT_ONLY === '1'
const VIEW_IMAGE_ONLY = process.argv.includes('--view-image-only')
const SHORT_CONVERSATION_ONLY = process.argv.includes('--short-conversation-only')
const RETRY_ONLY = process.argv.includes('--retry-only')
const RATE_LIMIT_ONLY = process.argv.includes('--rate-limit-only')
const RUNNING_FORK_ONLY = process.argv.includes('--running-fork-only')
const COMPLETED_FORK_ONLY = process.argv.includes('--completed-fork-only')
const SIDE_CHAT_ONLY = process.argv.includes('--side-chat-only')
const GOAL_IDLE_ONLY = process.argv.includes('--goal-idle-only')
const GOAL_RESTART_ONLY = process.argv.includes('--goal-restart-only')
const TURN_NAVIGATION_ONLY = process.argv.includes('--turn-navigation-only')
const ATTACHMENT_ONLY = process.argv.includes('--attachment-only')
const PASTED_WORKSPACE_PATHS_ONLY = process.argv.includes('--pasted-workspace-paths-only')
const DROPPED_WORKSPACE_PATHS_ONLY = process.argv.includes('--dropped-workspace-paths-only')
const SYSTEM_DRAG_PANEL_ONLY = process.argv.includes('--system-drag-panel-only')
const MODEL_SWITCH_ONLY = process.argv.includes('--model-switch-only')
const CLOUD_ONLY = process.argv.includes('--cloud-only')
const PLUGINS_ONLY = process.argv.includes('--plugins-only')
const AUTOMATION_ONLY = process.argv.includes('--automation-only')
const MEMORY_ONLY = process.argv.includes('--memory-only')
const TOOL_BLOCK_ORDER_ONLY = process.argv.includes('--tool-block-order-only')
const QUEUE_NAVIGATION_ONLY = process.argv.includes('--queue-navigation-only')
const GUIDANCE_BACKGROUND_ONLY = process.argv.includes('--guidance-background-only')
const GUIDANCE_SCROLL_ONLY = process.argv.includes('--guidance-scroll-only')
const MESSAGE_RESTORATION_ONLY = process.argv.includes('--message-restoration-only')
const QUEUE_MANAGEMENT_ONLY = process.argv.includes('--queue-management-only')
const TASK_PLAN_ONLY = process.argv.includes('--task-plan-only')
const BUILD_ONLY = process.argv.includes('--build-only')
const DESKTOP_SCENARIO_ONLY = process.env.WEWORK_E2E_DESKTOP_SCENARIO_ONLY === 'true'
const MIXED_TOOL_TURNS_ONLY = process.env.WEWORK_E2E_MIXED_TOOL_TURNS_ONLY === '1'
const DESKTOP_SEGMENT = readCommandLineOption('--segment')
const DESKTOP_FROM_SEGMENT = readCommandLineOption('--from-segment')
const SELECTED_DESKTOP_SEGMENT = DESKTOP_SEGMENT ?? DESKTOP_FROM_SEGMENT
const RUNS_PLUGIN_E2E =
  PLUGINS_ONLY || (SELECTED_DESKTOP_SEGMENT && PLUGIN_SEGMENTS.includes(SELECTED_DESKTOP_SEGMENT))
const VERIFIES_INITIAL_TELEMETRY_CONSENT =
  !SELECTED_DESKTOP_SEGMENT || SELECTED_DESKTOP_SEGMENT === 'telemetry-consent'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..', '..')
const repoDir = resolve(weworkDir, '..')
const toolDetailsMcpServerPath = join(weworkDir, 'e2e', 'utils', 'tool-details-mcp-server.mjs')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const resultDir = join(weworkDir, 'test-results', 'desktop-e2e', runId)

const OFFICIAL_PLUGIN_REPOSITORY = 'https://github.com/openai/plugins.git'
const OFFICIAL_PLUGIN_REPOSITORY_PREFIX = 'https://github.com/openai/plugins'
const OFFICIAL_PLUGIN_REVISION = '11c74d6ba24d3a6d48f54a194cd00ef3beea18f9'
const OFFICIAL_PLUGIN_NAME = 'openai-developers'
const OFFICIAL_PLUGIN_DISPLAY_NAME = 'OpenAI Developers'
const OFFICIAL_PLUGIN_MARKETPLACE_NAME = 'desktop-e2e-openai-official'
const OFFICIAL_PLUGIN_SKILL_NAME = 'openai-platform-api-key'
const OFFICIAL_PLUGIN_SKILL_MARKER = '# OpenAI API Key'
const OFFICIAL_PLUGIN_MCP_NAMESPACE = 'openai_api_key_local_confirmation'
const OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION = 'local env-file destination'
const OFFICIAL_PLUGIN_TOOL_SEARCH_ID = 'wework-e2e-official-plugin-search'
const OFFICIAL_PLUGIN_MCP_TOOL_ID = 'wework-e2e-official-plugin-mcp'
const OFFICIAL_PLUGIN_SKILL_READY_TEXT = 'WEWORK_DESKTOP_E2E_OFFICIAL_PLUGIN_SKILL_READY'
const OFFICIAL_PLUGIN_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_OFFICIAL_PLUGIN_COMPLETE'
const PLUGIN_MARKETPLACE_NAME = 'desktop-e2e-marketplace'
const PLUGIN_NAME = 'desktop-e2e-plugin'
const PLUGIN_CREATOR_PROMPT = 'Create a desktop E2E verification plugin'
const PLUGIN_CREATOR_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_PLUGIN_CREATOR_COMPLETE'
const PLUGIN_REFINEMENT_PROMPT =
  'You are refining a task before the user sends it to an installed plugin.'
const PLUGIN_REFINEMENT_COMPLETION_TEXT =
  'Summarize the current project status, focusing on changed files, open risks, and next actions.'
const PLUGIN_DISPLAY_NAME = 'Desktop E2E Plugin'
const CONNECTOR_AUTH_MARKER_NAME = 'desktop-e2e-browser-auth'
const CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT =
  'Verify recovery behavior when no matching local identity is installed.'
const CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT =
  'connector_auth_required need_login pluginKey=github connectorSlug=github WEWORK_DESKTOP_E2E_UNMATCHED_CONNECTOR_AUTH_RESUME'
const STARTUP_NETWORK_PROBE_MARKETPLACE_NAME = 'desktop-e2e-startup-network-probe'
const STARTUP_NETWORK_PROBE_MARKETPLACE_URL =
  'https://desktop-e2e-startup-probe.invalid/marketplace.git'
const STARTUP_NETWORK_PROBE_REQUEST_PATTERN = /desktop-e2e-startup-probe\.invalid/i
const AUTOMATION_NAME = 'Desktop E2E automation'
const AUTOMATION_PROMPT = 'WEWORK_DESKTOP_E2E_AUTOMATION: report the current workspace status.'
const AUTOMATION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_AUTOMATION_COMPLETE'
const AUTOMATION_SCHEDULE_TIMEOUT_MS = 70_000
const QUALIFIED_SKILL_MENTION_PROMPT = 'Verify the sent qualified skill mention.'
const QUALIFIED_SKILL_MENTION_COMPLETION_TEXT =
  'WEWORK_DESKTOP_E2E_QUALIFIED_SKILL_MENTION_COMPLETE'

function readCommandLineOption(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a segment name`)
  }
  return value
}

function getActiveOnlyModes() {
  return [
    ['WEWORK_DESKTOP_E2E_REQUEST_INPUT_ONLY=1', REQUEST_INPUT_ONLY],
    ['--view-image-only', VIEW_IMAGE_ONLY],
    ['--short-conversation-only', SHORT_CONVERSATION_ONLY],
    ['--retry-only', RETRY_ONLY],
    ['--rate-limit-only', RATE_LIMIT_ONLY],
    ['--running-fork-only', RUNNING_FORK_ONLY],
    ['--completed-fork-only', COMPLETED_FORK_ONLY],
    ['--side-chat-only', SIDE_CHAT_ONLY],
    ['--goal-idle-only', GOAL_IDLE_ONLY],
    ['--goal-restart-only', GOAL_RESTART_ONLY],
    ['--turn-navigation-only', TURN_NAVIGATION_ONLY],
    ['--attachment-only', ATTACHMENT_ONLY],
    ['--pasted-workspace-paths-only', PASTED_WORKSPACE_PATHS_ONLY],
    ['--dropped-workspace-paths-only', DROPPED_WORKSPACE_PATHS_ONLY],
    ['--system-drag-panel-only', SYSTEM_DRAG_PANEL_ONLY],
    ['--model-switch-only', MODEL_SWITCH_ONLY],
    ['--cloud-only', CLOUD_ONLY],
    ['--plugins-only', PLUGINS_ONLY],
    ['--automation-only', AUTOMATION_ONLY],
    ['--memory-only', MEMORY_ONLY],
    ['--tool-block-order-only', TOOL_BLOCK_ORDER_ONLY],
    ['--queue-navigation-only', QUEUE_NAVIGATION_ONLY],
    ['--guidance-background-only', GUIDANCE_BACKGROUND_ONLY],
    ['--guidance-scroll-only', GUIDANCE_SCROLL_ONLY],
    ['--message-restoration-only', MESSAGE_RESTORATION_ONLY],
    ['--queue-management-only', QUEUE_MANAGEMENT_ONLY],
    ['--task-plan-only', TASK_PLAN_ONLY],
    ['--build-only', BUILD_ONLY],
    ['WEWORK_E2E_DESKTOP_SCENARIO_ONLY=true', DESKTOP_SCENARIO_ONLY],
    ['WEWORK_E2E_MIXED_TOOL_TURNS_ONLY=1', MIXED_TOOL_TURNS_ONLY],
  ].filter(([, enabled]) => enabled)
}

function validateDesktopSegmentOptions() {
  if (DESKTOP_SEGMENT && DESKTOP_FROM_SEGMENT) {
    throw new Error('--segment and --from-segment cannot be used together')
  }
  const activeOnlyModes = getActiveOnlyModes()
  if (activeOnlyModes.length > 1) {
    throw new Error(
      `Desktop E2E only modes are mutually exclusive: ${activeOnlyModes
        .map(([name]) => name)
        .join(', ')}`
    )
  }
  const availableSegments = [...DESKTOP_CHECKPOINTS, ...PLUGIN_SEGMENTS]
  if (SELECTED_DESKTOP_SEGMENT && !availableSegments.includes(SELECTED_DESKTOP_SEGMENT)) {
    throw new Error(
      `Unknown desktop E2E segment "${SELECTED_DESKTOP_SEGMENT}". Available segments: ${availableSegments.join(', ')}`
    )
  }
  if (PLUGINS_ONLY && DESKTOP_CHECKPOINTS.includes(SELECTED_DESKTOP_SEGMENT)) {
    throw new Error('--plugins-only accepts only plugin E2E segments')
  }
  if (BUILD_ONLY && !process.env.WEWORK_E2E_BUILD_MANIFEST) {
    throw new Error('--build-only requires WEWORK_E2E_BUILD_MANIFEST')
  }
}

function shouldRunDesktopCheckpoint(checkpoint) {
  const checkpointIndex = DESKTOP_CHECKPOINTS.indexOf(checkpoint)
  assert.notEqual(checkpointIndex, -1, `Unknown desktop E2E checkpoint: ${checkpoint}`)
  if (DESKTOP_SEGMENT) return checkpoint === DESKTOP_SEGMENT
  if (!DESKTOP_FROM_SEGMENT) return true
  return checkpointIndex >= DESKTOP_CHECKPOINTS.indexOf(DESKTOP_FROM_SEGMENT)
}

function shouldStopAfterDesktopCheckpoint(checkpoint) {
  return DESKTOP_SEGMENT === checkpoint
}

function shouldConfigureToolDetailsMcp() {
  if (TOOL_BLOCK_ORDER_ONLY) return true
  return getActiveOnlyModes().length === 0 && shouldRunDesktopCheckpoint('rendering-extensions')
}

function shouldRunPluginSegment(segment) {
  const segmentIndex = PLUGIN_SEGMENTS.indexOf(segment)
  assert.notEqual(segmentIndex, -1, `Unknown plugin E2E segment: ${segment}`)
  if (!RUNS_PLUGIN_E2E) return false
  if (DESKTOP_SEGMENT) return segment === DESKTOP_SEGMENT
  if (!DESKTOP_FROM_SEGMENT) return true
  return segmentIndex >= PLUGIN_SEGMENTS.indexOf(DESKTOP_FROM_SEGMENT)
}

async function findFileBySuffix(root, suffix) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const match = await findFileBySuffix(path, suffix)
      if (match) return match
    } else if (path.endsWith(suffix)) {
      return path
    }
  }
  return null
}

async function createOfficialPluginMarketplaceFixture({ marketplaceRoot, repositoryRoot }) {
  await mkdir(repositoryRoot, { recursive: true })
  await runChecked('git', ['init'], { cwd: repositoryRoot })
  await runChecked('git', ['remote', 'add', 'origin', OFFICIAL_PLUGIN_REPOSITORY], {
    cwd: repositoryRoot,
  })
  await runChecked('git', ['fetch', '--depth', '1', 'origin', OFFICIAL_PLUGIN_REVISION], {
    cwd: repositoryRoot,
  })
  await runChecked('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: repositoryRoot })
  assert.equal(
    commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    OFFICIAL_PLUGIN_REVISION,
    'The official plugin fixture did not resolve to the pinned OpenAI revision'
  )

  const marketplaceManifestDir = join(marketplaceRoot, '.agents', 'plugins')
  const marketplacePluginsDir = join(marketplaceRoot, 'plugins')
  await Promise.all([
    mkdir(marketplaceManifestDir, { recursive: true }),
    mkdir(marketplacePluginsDir, { recursive: true }),
  ])
  await symlink(
    join(repositoryRoot, 'plugins', OFFICIAL_PLUGIN_NAME),
    join(marketplacePluginsDir, OFFICIAL_PLUGIN_NAME),
    'dir'
  )
  await writeFile(
    join(marketplaceManifestDir, 'marketplace.json'),
    `${JSON.stringify(
      {
        name: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
        interface: { displayName: 'OpenAI official E2E' },
        plugins: [
          {
            name: OFFICIAL_PLUGIN_NAME,
            source: { source: 'local', path: `./plugins/${OFFICIAL_PLUGIN_NAME}` },
          },
        ],
      },
      null,
      2
    )}\n`
  )
}

async function createPluginMarketplaceFixture(root) {
  const marketplaceManifestDir = join(root, '.agents', 'plugins')
  const pluginRoot = join(root, 'plugins', PLUGIN_NAME)
  await Promise.all([
    mkdir(marketplaceManifestDir, { recursive: true }),
    mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true }),
    mkdir(join(pluginRoot, 'scripts'), { recursive: true }),
    mkdir(join(pluginRoot, 'skills', 'desktop-e2e-skill'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      join(marketplaceManifestDir, 'marketplace.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_MARKETPLACE_NAME,
          interface: { displayName: 'Desktop E2E Marketplace' },
          plugins: [
            {
              name: PLUGIN_NAME,
              source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
              policy: {
                installation: 'AVAILABLE',
                authentication: 'ON_INSTALL',
              },
              category: 'Developer Tools',
            },
          ],
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(pluginRoot, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: PLUGIN_NAME,
          version: '0.1.0',
          description: 'Exercises the real Wework plugin lifecycle',
          author: { name: 'Wework Desktop E2E' },
          skills: './skills/',
          connectors: [
            {
              slug: 'desktop-e2e-browser-auth',
              authPolicy: 'on_install',
              localAuth: {
                kind: 'browser_oauth',
                health: ['scripts/local-auth.sh', 'health'],
                start: ['scripts/local-auth.sh', 'login'],
                logout: ['scripts/local-auth.sh', 'logout'],
                timeoutSeconds: 30,
                logoutOnUninstall: true,
              },
            },
          ],
          interface: {
            displayName: PLUGIN_DISPLAY_NAME,
            shortDescription: 'Exercises the real Wework plugin lifecycle',
            longDescription: 'Verifies plugin creation, installation, chat, and removal in Wework.',
            developerName: 'Wework Desktop E2E',
            category: 'Developer Tools',
            capabilities: [],
            defaultPrompt: 'Verify the Wework desktop plugin lifecycle.',
          },
        },
        null,
        2
      )}\n`
    ),
    writeFile(
      join(pluginRoot, 'scripts', 'local-auth.sh'),
      `#!/bin/sh
set -eu
marker="\${WEGENT_EXECUTOR_HOME}/desktop-e2e-browser-auth"
case "\${1:-health}" in
  health)
    if [ -f "\${marker}" ]; then
      printf '{"status":"ok","hint":"E2E authorization is ready."}\\n'
    else
      printf '{"status":"need_login","hint":"E2E authorization is required."}\\n'
    fi
    ;;
  login)
    sleep 1
    printf 'ready\\n' >"\${marker}"
    printf '{"status":"ok","hint":"E2E authorization is ready."}\\n'
    ;;
  logout)
    rm -f -- "\${marker}"
    printf '{"status":"ok","hint":"E2E authorization was removed."}\\n'
    ;;
esac
`
    ),
    writeFile(
      join(pluginRoot, 'scripts', 'local-auth.ps1'),
      `param([string]$Action = 'health')
$marker = Join-Path $env:WEGENT_EXECUTOR_HOME 'desktop-e2e-browser-auth'
switch ($Action) {
  'health' {
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
      Write-Output '{"status":"ok","hint":"E2E authorization is ready."}'
    } else {
      Write-Output '{"status":"need_login","hint":"E2E authorization is required."}'
    }
  }
  'login' {
    Start-Sleep -Seconds 1
    Set-Content -LiteralPath $marker -Value 'ready'
    Write-Output '{"status":"ok","hint":"E2E authorization is ready."}'
  }
  'logout' {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Write-Output '{"status":"ok","hint":"E2E authorization was removed."}'
  }
}
`
    ),
    writeFile(
      join(pluginRoot, 'skills', 'desktop-e2e-skill', 'SKILL.md'),
      `---\nname: desktop-e2e-skill\ndescription: Verifies the installed plugin can be used in chat.\n---\n\nUse this skill to verify the Wework desktop plugin flow.\n`
    ),
  ])
}

function withTimeout(promise, timeoutMs, message) {
  let timeout
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

function macosFrontmostProcessId() {
  const output = commandOutput('osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)',
  ])
  const processId = Number(output)
  assert.ok(Number.isInteger(processId), `Invalid macOS frontmost process ID: ${output}`)
  return processId
}

function macosApplicationProcessId(appIdentifier) {
  const output = commandOutput('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("AppKit"); const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(appIdentifier)}); apps.count > 0 ? Number(apps.objectAtIndex(0).processIdentifier) : 0`,
  ])
  const processId = Number(output)
  assert.ok(Number.isInteger(processId), `Invalid macOS application process ID: ${output}`)
  return processId
}

async function waitForMacosApplicationProcessId(appIdentifier, launcher) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DESKTOP_READY_TIMEOUT_MS) {
    const processId = macosApplicationProcessId(appIdentifier)
    if (processId > 0) return processId
    if (launcher.exitCode !== null || launcher.signalCode !== null) {
      throw new Error(`macOS failed to launch ${appIdentifier}`)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for macOS application ${appIdentifier}`)
}

async function stopDesktopAppProcess(app) {
  if (!app) return
  if (!app.launcher) {
    await stopProcessGroup(app)
    return
  }

  if (processIsAlive(app.pid)) process.kill(app.pid, 'SIGTERM')
  const startedAt = Date.now()
  while (processIsAlive(app.pid) && Date.now() - startedAt < 10_000) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  if (processIsAlive(app.pid)) process.kill(app.pid, 'SIGKILL')
  await stopProcess(app.launcher)
}

async function runChecked(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}`))
    })
  })
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Unable to reserve an E2E port')
  await new Promise(resolvePromise => server.close(resolvePromise))
  return address.port
}

class BlockingNetworkProxy {
  constructor() {
    this.requests = []
    this.sockets = new Set()
    this.released = false
    this.server = createTcpServer(socket => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => this.sockets.delete(socket))
      if (this.released) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      let request = ''
      socket.on('data', chunk => {
        if (request) return
        request = chunk.toString('utf8').split(/\r?\n/, 1)[0]?.trim() ?? ''
        if (request) this.requests.push(request)
      })
    })
  }

  async start() {
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = this.server.address()
    assert.ok(address && typeof address !== 'string', 'Unable to start blocking network proxy')
    this.url = `http://127.0.0.1:${address.port}`
  }

  async waitForRequest(timeoutMs = WORKBENCH_READY_TIMEOUT_MS) {
    return this.waitForRequestAfter(0, timeoutMs)
  }

  async waitForRequestAfter(requestCount, timeoutMs = WORKBENCH_READY_TIMEOUT_MS) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.requests.length > requestCount) return this.requests[requestCount]
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
    }
    throw new Error('Codex did not reach the blocking network proxy')
  }

  async waitForRequestMatchingAfter(requestCount, pattern, timeoutMs = WORKBENCH_READY_TIMEOUT_MS) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const request = this.requests.slice(requestCount).find(candidate => pattern.test(candidate))
      if (request) return request
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
    }
    const observedRequests = this.requests.slice(requestCount)
    throw new Error(
      `Codex did not send a startup request matching ${pattern}; observed=${JSON.stringify(observedRequests)}`
    )
  }

  requestCount() {
    return this.requests.length
  }

  release() {
    if (this.released) return
    this.released = true
    for (const socket of this.sockets) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
  }

  async stop() {
    this.release()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise(resolvePromise => this.server.close(resolvePromise))
  }
}

async function waitForUrl(url, message, timeoutMs = WORKBENCH_READY_TIMEOUT_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The real service is still starting.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(message)
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  const body = await response.json()
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${url} failed: ${JSON.stringify(body)}`
  )
  return body
}

async function resolveExecutable(configuredPath, fallbackCommand, description) {
  const candidate = configuredPath?.trim()
  if (candidate) {
    const absolutePath = resolve(candidate)
    assert.equal(
      await isExecutable(absolutePath),
      true,
      `${description} is not executable: ${absolutePath}`
    )
    return absolutePath
  }

  const resolved = commandOutput('which', [fallbackCommand])
  assert.equal(await isExecutable(resolved), true, `${description} is not executable: ${resolved}`)
  return resolved
}

async function appendProcessOutput(stream, destination) {
  if (!stream) return
  stream.on('data', chunk => {
    void appendFile(destination, chunk)
  })
}

async function sendPrompt(control, selector, prompt) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('press', selector, { key: 'Enter' })
}

async function sendPromptWithButton(
  control,
  selector,
  prompt,
  timeoutMs = MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  { confirmCloudModelCatalogSync = false } = {}
) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pause-response-button'),
    'The active task did not become idle before sending the next prompt'
  )
  await control.command('fill', selector, { value: prompt })
  await control.command('waitFor', selector, {
    text: prompt,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs,
  })
  await control.command('press', selector, { key: 'Enter', timeoutMs })
  if (confirmCloudModelCatalogSync) {
    await control.command('waitFor', '[data-testid="cloud-model-catalog-sync-dialog"]', {
      visible: true,
      timeoutMs,
    })
    await captureVerificationScreenshot(
      control,
      'cloud-model-catalog-sync-confirmation.png',
      '[data-testid="cloud-model-catalog-sync-dialog"]'
    )
    await control.command(
      'clickWhenEnabled',
      '[data-testid="cloud-model-catalog-sync-confirm-button"]',
      { timeoutMs }
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('cloud-model-catalog-sync-dialog'),
      'The cloud model catalog sync dialog did not close after Codex restarted',
      timeoutMs
    )
  }
  await waitForSuccessfulMatrixSubmission(control, selector, prompt, timeoutMs)
}

async function assertConversationMessageState(control, { assistantText, userText }) {
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: userText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const transcriptText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
  )
  assert.equal(
    countTextOccurrences(transcriptText, userText),
    1,
    `The restored conversation rendered "${userText}" more than once`
  )
  if (!assistantText) return

  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: assistantText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const completedTranscriptText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
  )
  const userIndex = completedTranscriptText.indexOf(userText)
  const assistantIndex = completedTranscriptText.indexOf(assistantText)
  assert.ok(userIndex >= 0, `The completed conversation lost "${userText}"`)
  assert.ok(assistantIndex >= 0, `The completed conversation lost "${assistantText}"`)
  assert.ok(
    userIndex < assistantIndex,
    `The assistant response "${assistantText}" appeared above its user message "${userText}"`
  )
}

function assertConversationTextOrder(transcriptText, expectedTexts) {
  let previousIndex = -1
  for (const expectedText of expectedTexts) {
    const currentIndex = transcriptText.indexOf(expectedText)
    assert.ok(currentIndex >= 0, `The restored conversation lost "${expectedText}"`)
    assert.ok(
      currentIndex > previousIndex,
      `The restored conversation rendered "${expectedText}" out of order`
    )
    previousIndex = currentIndex
  }
}

async function verifyUserMessageNavigation({
  assistantText,
  control,
  projectRowSelector,
  screenshotPrefix,
  taskRowTestId,
  userText,
}) {
  await assertConversationMessageState(control, { assistantText, userText })
  await captureVerificationScreenshot(control, `${screenshotPrefix}-01-before-switch.png`)

  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureTaskRowVisible(control, taskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await assertConversationMessageState(control, { assistantText, userText })
  await captureVerificationScreenshot(control, `${screenshotPrefix}-02-after-restore.png`)
}

async function verifyFollowUpMessageRestoration({
  composerSelector,
  control,
  projectRowSelector,
  taskRowTestId,
}) {
  control.setScenario('follow_up')
  const followUpRequest = await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    FOLLOW_UP_PROMPT,
    'follow_up'
  )
  await verifyUserMessageNavigation({
    control,
    projectRowSelector,
    screenshotPrefix: 'follow-up-message-pending',
    taskRowTestId,
    userText: FOLLOW_UP_PROMPT,
  })
  control.releaseFollowUpResponse()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await verifyUserMessageNavigation({
    assistantText: FOLLOW_UP_COMPLETION_TEXT,
    control,
    projectRowSelector,
    screenshotPrefix: 'follow-up-message-completed',
    taskRowTestId,
    userText: FOLLOW_UP_PROMPT,
  })
  assert.ok(
    JSON.stringify(followUpRequest.body).includes(FOLLOW_UP_PROMPT),
    'The follow-up request did not preserve the user prompt'
  )
}

async function verifyQueuedFollowUpNavigation({
  composerSelector,
  control,
  projectRowSelector,
  runningTaskRowTestId,
}) {
  await control.command('fill', composerSelector, { value: QUEUED_FOLLOW_UP })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: QUEUED_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'queue-navigation-01-source-queued.png')

  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up leaked into the other conversation'
  )
  await captureVerificationScreenshot(control, 'queue-navigation-02-other-conversation.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  const taskOrderBeforeRestore = JSON.parse(
    await control.command('snapshot', '[data-testid="sidebar-worklists-scroll"]')
  ).testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: QUEUED_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const taskOrderAfterRestore = JSON.parse(
    await control.command('snapshot', '[data-testid="sidebar-worklists-scroll"]')
  ).testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  assert.deepEqual(
    taskOrderAfterRestore,
    taskOrderBeforeRestore,
    'Opening a streaming task changed the sidebar task order before its turn completed'
  )
  await captureVerificationScreenshot(control, 'queue-navigation-03-source-restored.png')

  await control.command('click', '[data-testid^="queue-cancel-button-"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The queued follow-up could not be cleared after restoration'
  )
}

async function ensurePlanMode(control) {
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (snapshot.testIds.includes('plan-mode-pill')) return

  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('click', '[data-testid="set-plan-mode-button"]')
  await control.command('waitFor', '[data-testid="plan-mode-pill"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyBackgroundTaskPlanRestoration({ composerSelector, control }) {
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    initialSnapshot.testIds.includes('add-context-button') &&
      initialSnapshot.testIds.includes('new-chat-button'),
    'The task-plan verification did not start from a ready workbench'
  )
  control.setScenario('task_plan')
  await ensurePlanMode(control)
  await sendPromptUntilScenarioRequest(control, composerSelector, TASK_PLAN_PROMPT, 'task_plan')
  const taskPlanDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const taskPlanTaskId = taskPlanDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskPlanTaskId, 'The task-plan scenario did not expose its runtime task ID')
  const taskPlanTaskRowTestId = `runtime-local-task-row-${taskPlanTaskId}`
  await control.command('waitFor', `[data-testid="${taskPlanTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await withTimeout(
    control.releaseTaskPlanResponse(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the background task-plan response'
  )
  await control.command('click', `[data-testid="${taskPlanTaskRowTestId}"]`)
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskPlanTaskId &&
      snapshot.pane?.transcript?.loading === false,
    'The background task-plan transcript did not finish loading'
  )
  await control.command('waitFor', '[data-testid="assistant-plan-card"]', {
    text: TASK_PLAN_STEP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text: TASK_PLAN_STEP,
    value: 'background-task-plan-message',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command(
      'getElementCount',
      '[data-e2e-anchor-id="background-task-plan-message"] [data-testid="final-processing-toggle"]'
    ),
    '0',
    'The completed task plan was collapsed into the final processing summary'
  )
  await captureVerificationScreenshot(control, '01-background-task-plan-restored.png')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('waitFor', '[data-testid="add-context-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyBackgroundGuidanceNavigation({
  composerSelector,
  control,
  otherTaskRowTestId,
  runningTaskRowTestId,
}) {
  const sourceUserMessageCountBeforeGuidance = Number(
    await control.command('getElementCount', '[data-testid="message-user"]')
  )

  await control.command('fill', composerSelector, { value: BACKGROUND_GUIDANCE })
  await control.command('click', '[data-testid="send-mode-menu-button"]')
  await control.command('click', '[data-testid="guide-current-turn-option"]')
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: BACKGROUND_GUIDANCE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const guidanceStatus = await control.command(
    'getText',
    '[data-testid="conversation-queue-panel"]'
  )
  assert.match(guidanceStatus, /引导中|Guiding/, 'The guidance did not enter its sending state')
  await captureVerificationScreenshot(control, 'guidance-background-01-sending.png')

  await ensureTaskRowVisible(control, otherTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes(BACKGROUND_GUIDANCE),
    'The pending guidance leaked into the other conversation'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(control, 'guidance-background-02-other-task.png')

  control.holdInitialCompletionResponse()
  control.releaseInitialToolExecution()
  await withTimeout(
    control.awaitScenarioRequestCount('initial', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guided background task did not continue after its tool completed'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes(BACKGROUND_GUIDANCE),
    'The applied background guidance appeared in the conversation the user was viewing'
  )
  await captureVerificationScreenshot(control, 'guidance-background-03-applied-in-background.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: BACKGROUND_GUIDANCE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const assistantContinuationSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="process-file-changes-block"]`
  await control.command('waitFor', assistantContinuationSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const activeGuidanceUserMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const activeAssistantContinuations = await getElementMetrics(
    control,
    assistantContinuationSelector
  )
  const activeGuidance = activeGuidanceUserMessages.at(-1)
  const activeAssistantContinuation = activeAssistantContinuations.at(-1)
  assert.ok(activeGuidance, 'The active background guidance message was not rendered')
  assert.ok(
    activeAssistantContinuation,
    'The active assistant continuation after background guidance was not rendered'
  )
  assert.ok(
    activeGuidance.top < activeAssistantContinuation.top,
    'The active background guidance message was appended after the running assistant'
  )
  control.releaseInitialCompletionResponse()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes('引导中') &&
      !snapshot.text.includes('Guiding'),
    'The applied background guidance remained stuck in its sending state'
  )
  const appliedUserMessageCount = Number(
    await control.command('getElementCount', '[data-testid="message-user"]')
  )
  assert.equal(
    appliedUserMessageCount,
    sourceUserMessageCountBeforeGuidance + 1,
    'The applied guidance did not add exactly one user message to the source conversation'
  )
  assert.equal(
    await control.command('getValue', composerSelector),
    '',
    'The applied guidance was unexpectedly restored into the composer'
  )
  await captureVerificationScreenshot(control, 'guidance-background-04-applied.png')

  await ensureTaskRowVisible(control, otherTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes(BACKGROUND_GUIDANCE),
    'The settled guidance leaked after the user left its source conversation again'
  )
  await captureVerificationScreenshot(control, 'guidance-background-05-left-again.png')

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const restoredSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_GUIDANCE) &&
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.text.includes('引导中') &&
      !snapshot.text.includes('Guiding'),
    'The settled guidance did not remain stable after reopening its source conversation'
  )
  assert.ok(
    restoredSnapshot.text.includes(BACKGROUND_GUIDANCE),
    'Reopening the source conversation lost the applied guidance'
  )
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="message-user"]')),
    appliedUserMessageCount,
    'Reopening the source conversation duplicated the applied user message'
  )
  const restoredUserMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const restoredAssistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const restoredGuidance = restoredUserMessages.at(-1)
  const assistantAfterGuidance = restoredAssistantMessages.at(-1)
  assert.ok(restoredGuidance, 'The restored guidance message was not rendered')
  assert.ok(assistantAfterGuidance, 'The assistant continuation after guidance was not rendered')
  assert.ok(
    restoredGuidance.top < assistantAfterGuidance.top,
    'The restored guidance message was appended after the assistant continuation'
  )
  await captureVerificationScreenshot(control, 'guidance-background-06-restored.png')

  const readyCountBeforeReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeReload),
    WORKBENCH_READY_TIMEOUT_MS,
    'The reloaded Wework WebView did not reconnect after background guidance'
  )
  await control.command('waitFor', `[data-testid="${runningTaskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const reloadedGuidanceSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_GUIDANCE) &&
      snapshot.text.includes(COMPLETION_TEXT) &&
      !snapshot.testIds.includes('conversation-queue-panel') &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Reloading reordered or unsettled the completed background guidance conversation',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="message-user"]')),
    appliedUserMessageCount,
    'Reloading duplicated the applied guidance user message'
  )
  const reloadedUserMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const reloadedAssistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const reloadedGuidance = reloadedUserMessages.at(-1)
  const reloadedAssistantContinuation = reloadedAssistantMessages.at(-1)
  assert.ok(reloadedGuidance, 'Reloading lost the applied guidance message')
  assert.ok(
    reloadedAssistantContinuation,
    'Reloading lost the assistant continuation after guidance'
  )
  assert.ok(
    reloadedGuidance.top < reloadedAssistantContinuation.top,
    'Reloading moved guidance after the assistant continuation'
  )
  assert.ok(
    reloadedGuidanceSnapshot.text.includes(BACKGROUND_GUIDANCE),
    'Reloading lost the background guidance text'
  )
  await captureVerificationScreenshot(control, 'guidance-background-07-reloaded.png')

  await verifyForegroundGuidanceScroll({
    composerSelector,
    control,
    returnTaskRowTestId: runningTaskRowTestId,
  })
  return runningTaskRowTestId
}

async function verifyForegroundGuidanceScroll({ composerSelector, control, returnTaskRowTestId }) {
  control.setScenario('guidance_scroll')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await sendPrompt(control, composerSelector, GUIDANCE_SCROLL_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('guidance_scroll', 1),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guidance scroll scenario did not receive its setup prompt'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_RESPONSE',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text: 'WEWORK_DESKTOP_E2E_GUIDANCE_SCROLL_RESPONSE',
    value: 'guidance-scroll-setup-assistant',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const scrollerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
  await waitForOverflowMetrics(
    control,
    scrollerSelector,
    'The guidance scroll fixture did not overflow before sending guidance'
  )

  await sendPrompt(control, composerSelector, GUIDANCE_SCROLL_ACTIVE_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('guidance_scroll', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guidance scroll scenario did not receive its active prompt'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('scrollToRatioAsUser', scrollerSelector, { value: '0.2' })

  await control.command('fill', composerSelector, { value: GUIDANCE_SCROLL_MESSAGE })
  await control.command('click', '[data-testid="send-mode-menu-button"]')
  await control.command('click', '[data-testid="guide-current-turn-option"]')
  await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
    text: GUIDANCE_SCROLL_MESSAGE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  control.releaseGuidanceScrollToolExecution()
  await withTimeout(
    control.awaitScenarioRequestCount('guidance_scroll', 3),
    DEFAULT_STEP_TIMEOUT_MS,
    'The guided turn did not continue after its tool completed'
  )
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: GUIDANCE_SCROLL_MESSAGE,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GUIDANCE_SCROLL_PRE_TOOL_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('markElementWithText', '[data-testid="message-assistant"]', {
    text: GUIDANCE_SCROLL_PRE_TOOL_TEXT,
    value: 'guidance-scroll-pre-tool-assistant',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const assistantAfterGuidanceText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]:not([data-e2e-anchor-id])`
  )
  assert.equal(
    assistantAfterGuidanceText.includes(GUIDANCE_SCROLL_PRE_TOOL_TEXT),
    false,
    'The final text from before guidance was duplicated after the guidance message'
  )

  const { element: guidanceMessage, scroller } = await waitForElementInsideScroller(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
    scrollerSelector,
    'The newly applied guidance message did not become visible'
  )
  assert.ok(
    guidanceMessage.top >= scroller.top - 2 && guidanceMessage.bottom <= scroller.bottom + 2,
    `The newly applied guidance message was outside the viewport: ${JSON.stringify({
      guidanceMessage,
      scroller,
    })}`
  )
  await captureVerificationScreenshot(control, 'guidance-scroll-01-message-visible.png')

  control.releaseGuidanceScrollCompletion()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GUIDANCE_SCROLL_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (returnTaskRowTestId) {
    await ensureTaskRowVisible(control, returnTaskRowTestId)
    await control.command('clickWhenEnabled', `[data-testid="${returnTaskRowTestId}"]`, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="message-user"]', {
      text: BACKGROUND_GUIDANCE,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
}

async function verifyVirtualizedTurnNavigationActiveMarker(control) {
  const turnNumber = TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN
  const promptText = `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
  const previewSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-preview"]`
  await control.command('waitFor', previewSelector, {
    text: promptText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const turnIndex = await control.command('getAttribute', previewSelector, {
    text: promptText,
    value: 'data-turn-index',
  })
  assert.match(turnIndex, /^\d+$/, `Unable to identify the navigation marker for "${promptText}"`)
  const targetResponseText = `Virtualized navigation response ${turnNumber}.1`
  await control.command(
    'scrollToRatioAsUser',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
    { value: '0' }
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: targetResponseText,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )

  const assistantText = await control.command(
    'scrollIntoViewAsUser',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: targetResponseText }
  )
  const turnMatch = assistantText.match(/Virtualized navigation response (\d+)\.\d+/)
  assert.ok(turnMatch, `Unable to identify the virtualized navigation turn from "${assistantText}"`)

  assert.equal(Number(turnMatch[1]), turnNumber, 'Scrolled to the wrong navigation turn')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 750))

  const mountedUserMessages = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  assert.ok(
    !mountedUserMessages.includes(promptText),
    `Turn ${turnNumber} user row remained mounted, so the active-marker regression was not reproduced`
  )

  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-turn-navigation-marker"][data-turn-index="${turnIndex}"][data-active="true"]`,
    {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
}

async function reopenCurrentTurnNavigationTask(control, composerSelector, restartDesktopApp) {
  const debugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const taskId = debugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(taskId, 'The turn-navigation fixture did not expose its runtime task ID')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await restartDesktopApp()
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await ensureTaskRowVisible(control, `runtime-local-task-row-${taskId}`)
  await control.command('clickWhenEnabled', `[data-testid="runtime-local-task-row-${taskId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${TURN_NAVIGATION_REGRESSION_TURN_COUNT}`,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
}

async function verifyStandaloneViewImageTask({ composerSelector, control, projectRowSelector }) {
  control.setScenario('view_image')
  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPrompt(control, composerSelector, VIEW_IMAGE_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('view_image'),
    DEFAULT_STEP_TIMEOUT_MS,
    'The model service did not receive the standalone view_image request'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: VIEW_IMAGE_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await verifyViewImageProcessingBlock(control)
}

async function verifyVisionSidecar({ composerSelector, control, modelCase, projectRowSelector }) {
  control.setScenario('vision_sidecar')
  control.visionSidecarRequests = []

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await control.command(
      'clickWhenEnabled',
      `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
      { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, modelCase.mainOptionId, modelCase.mainLabel)
    await control.command('dropFile', composerSelector, {
      filename: 'vision-sidecar.png',
      mimeType: 'image/png',
      value: IMAGE_ARTIFACT_BASE64,
    })
    await control.command('waitFor', '[data-testid="attachment-badge"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(
      control,
      attempt === 0
        ? `${modelCase.source}-vision-sidecar-01-request-ready.png`
        : `${modelCase.source}-vision-sidecar-03-cache-request-ready.png`
    )
    await sendPrompt(control, composerSelector, VISION_SIDECAR_PROMPT)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: VISION_SIDECAR_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(
      control,
      attempt === 0
        ? `${modelCase.source}-vision-sidecar-02-response.png`
        : `${modelCase.source}-vision-sidecar-04-cache-hit-response.png`
    )
  }

  const visionRequests = control.visionSidecarRequests.filter(request => request.kind === 'vision')
  const mainRequests = control.visionSidecarRequests.filter(request => request.kind === 'main')
  assert.equal(visionRequests.length, 1, 'The repeated image description was not cached')
  assert.equal(mainRequests.length, 2, 'Both image turns did not reach the primary model')
}

async function startPausedQueueCase({ composerSelector, control, initialPrompt, queuedPrompts }) {
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)

  const requestCountBefore = control.scenarioRequests.get('queue_management')?.length ?? 0
  await sendPrompt(control, composerSelector, initialPrompt)
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      requestCountBefore + 1,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    `The queue management scenario did not receive ${initialPrompt}`
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  for (const prompt of queuedPrompts) {
    await control.command('fill', composerSelector, { value: prompt })
    await control.command('press', composerSelector, { key: 'Enter' })
    await control.command('waitFor', '[data-testid="conversation-queue-panel"]', {
      text: prompt,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }

  return requestCountBefore
}

async function pauseQueuedConversation(control) {
  await control.command('click', '[data-testid="pause-response-button"]')
  await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="resume-queue-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const queueText = await control.command('getText', '[data-testid="conversation-queue-panel"]')
  assert.match(queueText, /队列已暂停|Queue paused/, 'Stopping did not pause the queued messages')
}

function assertLatestScenarioRequestContains(control, scenario, prompt, message) {
  const request = control.scenarioRequests.get(scenario)?.at(-1)
  assert.ok(request, `${message}: no ${scenario} request was recorded`)
  assert.equal(latestModelInputText(request.body).includes(prompt), true, message)
}

async function verifyPausedQueueLifecycle({ composerSelector, control }) {
  control.setScenario('queue_management')

  const directRequestOffset = await startPausedQueueCase({
    composerSelector,
    control,
    initialPrompt: QUEUE_DIRECT_INITIAL,
    queuedPrompts: [QUEUE_DIRECT_FIRST, QUEUE_DIRECT_SECOND, QUEUE_DIRECT_THIRD],
  })
  const queueSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="conversation-queue-panel"]')
  )
  const dragHandleTestIds = queueSnapshot.testIds.filter(testId =>
    testId.startsWith('queue-drag-handle-')
  )
  assert.equal(dragHandleTestIds.length, 3, 'The three queued messages did not expose drag handles')
  const firstQueuedId = dragHandleTestIds[0].slice('queue-drag-handle-'.length)
  await control.command('drag', `[data-testid="${dragHandleTestIds[2]}"]`, {
    target: `[data-testid="conversation-queue-row-${firstQueuedId}"]`,
  })
  const reorderedText = await control.command('getText', '[data-testid="conversation-queue-panel"]')
  assert.ok(
    reorderedText.indexOf(QUEUE_DIRECT_THIRD) < reorderedText.indexOf(QUEUE_DIRECT_FIRST),
    'Dragging did not update the queued message order in real time'
  )
  await captureVerificationScreenshot(control, 'queue-management-01-reordered.png')

  await pauseQueuedConversation(control)
  assert.equal(
    control.scenarioRequests.get('queue_management')?.length,
    directRequestOffset + 1,
    'Stopping immediately sent a queued message instead of pausing the queue'
  )
  await captureVerificationScreenshot(control, 'queue-management-02-paused.png')

  await control.command('click', '[data-testid="resume-queue-button"]')
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      directRequestOffset + 2,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'Continuing the queue did not send its first message'
  )
  assertLatestScenarioRequestContains(
    control,
    'queue_management',
    QUEUE_DIRECT_THIRD,
    'Continuing the queue did not send the message moved to the top'
  )
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      directRequestOffset + 4,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'The resumed queue did not drain in its visible order'
  )
  const directRequests = control.scenarioRequests
    .get('queue_management')
    .slice(directRequestOffset + 1, directRequestOffset + 4)
    .map(request => latestModelInputText(request.body))
  assert.equal(directRequests[0].includes(QUEUE_DIRECT_THIRD), true)
  assert.equal(directRequests[1].includes(QUEUE_DIRECT_FIRST), true)
  assert.equal(directRequests[2].includes(QUEUE_DIRECT_SECOND), true)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'The directly resumed queue did not clear after sending'
  )

  const preserveRequestOffset = await startPausedQueueCase({
    composerSelector,
    control,
    initialPrompt: QUEUE_PRESERVE_INITIAL,
    queuedPrompts: [QUEUE_PRESERVE_QUEUED],
  })
  await pauseQueuedConversation(control)
  await control.command('fill', composerSelector, { value: QUEUE_PRESERVE_MANUAL })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="paused-queue-send-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="paused-queue-send-cancel-button"]')
  assert.equal(
    await control.command('getValue', composerSelector),
    QUEUE_PRESERVE_MANUAL,
    'Cancelling the paused-queue dialog discarded the composer input'
  )
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('click', '[data-testid="paused-queue-send-preserve-button"]')
  assert.equal(
    await control.command('getValue', composerSelector),
    '',
    'Preserving the queue did not clear the submitted composer input'
  )
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      preserveRequestOffset + 3,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'Preserving the queue did not send both the manual message and queued message'
  )
  const preserveRequests = control.scenarioRequests
    .get('queue_management')
    .slice(preserveRequestOffset + 1, preserveRequestOffset + 3)
    .map(request => latestModelInputText(request.body))
  assert.equal(preserveRequests[0].includes(QUEUE_PRESERVE_MANUAL), true)
  assert.equal(preserveRequests[1].includes(QUEUE_PRESERVE_QUEUED), true)

  const clearRequestOffset = await startPausedQueueCase({
    composerSelector,
    control,
    initialPrompt: QUEUE_CLEAR_INITIAL,
    queuedPrompts: [QUEUE_CLEAR_QUEUED],
  })
  await pauseQueuedConversation(control)
  await control.command('fill', composerSelector, { value: QUEUE_CLEAR_MANUAL })
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('click', '[data-testid="paused-queue-send-clear-button"]')
  await withTimeout(
    control.awaitScenarioRequestCount(
      'queue_management',
      clearRequestOffset + 2,
      QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS
    ),
    QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
    'Clearing the queue did not send the new manual message'
  )
  assertLatestScenarioRequestContains(
    control,
    'queue_management',
    QUEUE_CLEAR_MANUAL,
    'Clearing the queue sent the wrong message'
  )
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('conversation-queue-panel'),
    'Clearing the queue left queued messages visible'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  assert.equal(
    control.scenarioRequests.get('queue_management')?.length,
    clearRequestOffset + 2,
    'A cleared queued message was still sent'
  )
  await captureVerificationScreenshot(control, 'queue-management-03-dialog-paths.png')
}

async function waitForSuccessfulMatrixSubmission(control, selector, prompt, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (control.fatalError) throw control.fatalError
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('chat-input-error')) {
      const error = await control.command('getText', '[data-testid="chat-input-error"]')
      throw new Error(`The UI rejected ${prompt}: ${error}`)
    }
    const composerValue = await control.command('getValue', selector)
    if (composerValue === '' && snapshot.text.includes(prompt)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`The composer did not submit ${prompt} within ${timeoutMs}ms`)
}

async function verifyShortConversationLayout({ composerSelector, control }) {
  const taskRowsBeforeConversation = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await prepareCompletedTurnScreenshot(control)
  await captureVerificationScreenshot(control, 'short-conversation-00-ready.png')
  await control.command('fill', composerSelector, { value: FRESH_CHAT_PROMPT })
  await control.command('waitFor', composerSelector, {
    text: FRESH_CHAT_PROMPT,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'short-conversation-01-prompt-filled.png')
  await control.command('press', composerSelector, { key: 'Enter' })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await sendPrompt(control, composerSelector, `${FRESH_CHAT_PROMPT} FOLLOW_UP`)
  await waitForScenarioRequestCount(control, 'fresh_chat', 2)
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const shortConversationTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeConversation,
    'WEWORK_DESKTOP_E2E_FRESH_CHAT'
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('clickWhenEnabled', `[data-testid="${shortConversationTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const scroller = await getSingleElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll"]`,
    'The short conversation message scroller'
  )
  const userMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  const assistantMessages = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
  )
  const virtualRows = await getElementMetrics(
    control,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-index]`
  )
  assert.equal(userMessages.length, 2, 'The short conversation did not render both user messages')
  assert.equal(
    assistantMessages.length,
    2,
    'The reopened short conversation did not render both assistant messages'
  )
  assert.equal(
    virtualRows.length,
    4,
    'The unified virtual list did not mount every short-conversation turn'
  )
  assert.equal(
    await control.command(
      'getStyle',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"] [data-index]`,
      { value: 'position' }
    ),
    'absolute',
    'Short conversations did not use the unified virtual row layout'
  )
  const conversationSnapshot = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(conversationSnapshot.text, FRESH_CHAT_PROMPT) >= 2,
    'The reopened virtualized conversation lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(conversationSnapshot.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'The reopened virtualized conversation lost an earlier assistant message'
  )
  const firstMessage = userMessages[0]
  const messageTopOffset = firstMessage.top - scroller.top
  await writeFile(
    join(resultDir, 'short-conversation-layout-metrics.json'),
    `${JSON.stringify(
      {
        assistantMessages,
        firstMessage,
        messageTopOffset,
        scroller,
        userMessages,
        virtualRows,
      },
      null,
      2
    )}\n`
  )
  await captureVerificationScreenshot(control, 'short-conversation-02-completed-top-aligned.png')

  assert.ok(
    messageTopOffset >= 0,
    'The first short-conversation message rendered above the viewport'
  )
  assert.ok(
    messageTopOffset <= SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
    `The short conversation left ${messageTopOffset}px of blank space above its first message`
  )

  const taskRowsBeforeRace = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  const concurrentRequestCount = control.scenarioRequests.get('concurrent_memory')?.length ?? 0
  control.setScenario('concurrent_memory')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await sendPrompt(control, composerSelector, CONVERSATION_SWITCH_RACE_PROMPT)
  await control.awaitScenarioRequestCount('concurrent_memory', concurrentRequestCount + 1)
  const runningTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeRace,
    'WEWORK_DESKTOP_E2E_CONCURRENT_MEMORY_1'
  )

  await ensureTaskRowVisible(control, shortConversationTaskRowTestId)
  await control.command('clickWhenEnabled', `[data-testid="${shortConversationTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await ensureTaskRowVisible(control, runningTaskRowTestId)
  await control.command('clickThenMacrotask', `[data-testid="${runningTaskRowTestId}"]`, {
    target: `[data-testid="${shortConversationTaskRowTestId}"]`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FRESH_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const restoredAfterRace = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(restoredAfterRace.text, FRESH_CHAT_PROMPT) >= 2,
    'Rapid conversation switching lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(restoredAfterRace.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'Rapid conversation switching lost an earlier assistant message'
  )
  await captureVerificationScreenshot(control, 'short-conversation-03-rapid-switch-restored.png')
  control.releaseConcurrentMemoryResponses()
  const runningTaskId = runningTaskRowTestId.replace('runtime-local-task-row-', '')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`runtime-local-task-running-${runningTaskId}`),
    'The rapid-switch background task did not settle after its response was released'
  )
  const settledAfterRace = JSON.parse(
    await control.command(
      'snapshot',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-chat-scroll-content"]`
    )
  )
  assert.ok(
    countTextOccurrences(settledAfterRace.text, FRESH_CHAT_PROMPT) >= 2,
    'The settled rapid switch lost an earlier user message'
  )
  assert.ok(
    countTextOccurrences(settledAfterRace.text, FRESH_CHAT_COMPLETION_TEXT) >= 2,
    'The settled rapid switch lost an earlier assistant message'
  )
  assert.equal(
    settledAfterRace.text.includes(CONVERSATION_SWITCH_RACE_PROMPT),
    false,
    'The late background transcript leaked into the restored conversation'
  )
  control.setScenario('fresh_chat')
  return shortConversationTaskRowTestId
}

function countTextOccurrences(value, search) {
  if (!search) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(search, offset)
    if (index === -1) return count
    count += 1
    offset = index + search.length
  }
}

async function prepareCompletedTurnScreenshot(control) {
  await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const startedAt = Date.now()
  let menuClosedAt = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (snapshot.testIds.includes('model-selector-menu')) {
      menuClosedAt = null
      await control.command('pointerDown', ACTIVE_COMPOSER_SELECTOR)
    } else {
      menuClosedAt ??= Date.now()
      if (Date.now() - menuClosedAt >= COMPOSER_READY_STABILITY_MS) return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The model selector menu remained open before the verification screenshot')
}

async function waitForSnapshot(
  control,
  predicate,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  selector = 'body'
) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', selector))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  const relevantTestIds = (lastSnapshot?.testIds ?? []).filter(
    testId =>
      testId.startsWith('runtime-local-task-') ||
      testId.startsWith('composer-plugin-') ||
      testId.startsWith('plugin-trial-') ||
      testId.startsWith('workspace-') ||
      testId.startsWith('bottom-workspace-') ||
      [
        'goal-status-bar',
        'pause-response-button',
        'send-message-button',
        'thinking-indicator',
      ].includes(testId)
  )
  throw new Error(`${message}; relevant test IDs: ${JSON.stringify(relevantTestIds)}`)
}

async function openComposerPluginPicker(control) {
  const before = JSON.parse(await control.command('snapshot', 'body'))
  if (before.testIds.includes('composer-plugin-picker')) return
  await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  await control.command('waitFor', '[data-testid="composer-plugin-picker"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function closeComposerPluginPicker(control) {
  const open = JSON.parse(await control.command('snapshot', 'body'))
  if (!open.testIds.includes('composer-plugin-picker')) return
  await control.command('press', 'body', { key: 'Escape' })
  const stillOpen = await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('composer-plugin-picker'),
    'Closing the composer plugin picker did not dismiss the menu',
    DEFAULT_STEP_TIMEOUT_MS
  ).catch(() => null)
  if (stillOpen) return
  await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('composer-plugin-picker'),
    'Closing the composer plugin picker did not dismiss the menu'
  )
}

/**
 * Install → skills-changed can leave the picker empty briefly while listLocalApps
 * refreshes. Warm via slash autocomplete, reopen the picker, then search.
 */
async function waitForInstalledComposerPlugin(control, { pluginName, pluginDisplayName }) {
  const itemTestId = `composer-plugin-picker-item-plugin:${pluginName}`
  const slashOptionSelector = `[data-testid="slash-command-option-app-plugin-${pluginName}"]`
  const deadline = Date.now() + WORKBENCH_READY_TIMEOUT_MS
  const attemptBudgetMs = 3_000

  while (Date.now() < deadline) {
    await openComposerPluginPicker(control)

    // Prefer an already-warmed list before searching (search can hide a late paint).
    const alreadyVisible = JSON.parse(
      await control.command('snapshot', '[data-testid="composer-plugin-picker"]')
    )
    if (alreadyVisible.testIds.includes(itemTestId)) {
      return itemTestId
    }

    await control.command('fill', '[data-testid="composer-plugin-picker-search"]', {
      value: pluginDisplayName,
    })
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const matched = await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.includes(itemTestId),
      'waiting for composer plugin picker item',
      Math.min(attemptBudgetMs, remainingMs),
      '[data-testid="composer-plugin-picker"]'
    ).catch(() => null)
    if (matched) return itemTestId

    await closeComposerPluginPicker(control)

    // Warm listLocalApps through the slash menu, which shares the same apps source.
    const warmBudget = Math.min(attemptBudgetMs, deadline - Date.now())
    if (warmBudget > 0) {
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
        value: `/${pluginName.slice(0, 8)}`,
      })
      await control
        .command('waitFor', slashOptionSelector, {
          timeoutMs: warmBudget,
        })
        .catch(() => null)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '' })
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }

  await openComposerPluginPicker(control)
  await control.command('fill', '[data-testid="composer-plugin-picker-search"]', {
    value: pluginDisplayName,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(itemTestId),
    'The installed plugin did not appear in the composer plugin picker',
    DEFAULT_STEP_TIMEOUT_MS,
    '[data-testid="composer-plugin-picker"]'
  )
  return itemTestId
}

async function assertMentionRenderedAsToken(
  control,
  { tokenSelector, tokenText, plainTextMention, errorLabel }
) {
  await control.command('waitFor', tokenSelector, {
    ...(tokenText ? { text: tokenText } : {}),
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const userMessageText = await control.command(
    'getText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
  )
  assert.equal(userMessageText.includes(plainTextMention), false, errorLabel)
}

async function getElementMetrics(control, selector) {
  return JSON.parse(await control.command('getElementMetrics', selector))
}

async function getSingleElementMetrics(control, selector, description) {
  const metrics = await getElementMetrics(control, selector)
  assert.equal(metrics.length, 1, `${description} rendered ${metrics.length} matching elements`)
  return metrics[0]
}

async function waitForBottomMetrics(control, selector, description, timeoutMs = 1_500) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (distanceFromBottom(metrics) <= 2) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(
    `${description} remained ${distanceFromBottom(metrics)}px from the bottom after ${timeoutMs}ms`
  )
}

async function waitForOverflowMetrics(control, selector, description, timeoutMs = 3_000) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (metrics.scrollHeight > metrics.clientHeight) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${description} after ${timeoutMs}ms: ${JSON.stringify(metrics)}`)
}

async function waitForElementInsideScroller(
  control,
  elementSelector,
  scrollerSelector,
  description,
  timeoutMs = 3_000
) {
  const startedAt = Date.now()
  let element
  let scroller
  while (Date.now() - startedAt < timeoutMs) {
    scroller = await getSingleElementMetrics(control, scrollerSelector, description)
    element = (await getElementMetrics(control, elementSelector)).at(-1)
    if (element && element.top >= scroller.top - 2 && element.bottom <= scroller.bottom + 2) {
      return { element, scroller }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${description} after ${timeoutMs}ms: ${JSON.stringify({ element, scroller })}`)
}

async function waitForTopMetrics(control, selector, description, timeoutMs = 3_000) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (metrics.scrollTop <= 2) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(
    `${description} remained ${metrics.scrollTop}px from the top after ${timeoutMs}ms`
  )
}

async function waitForElementWidth(control, selector, predicate, description, timeoutMs = 1_500) {
  const startedAt = Date.now()
  let metrics
  while (Date.now() - startedAt < timeoutMs) {
    metrics = await getSingleElementMetrics(control, selector, description)
    if (predicate(metrics.width)) return metrics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${description} remained ${metrics.width}px wide after ${timeoutMs}ms`)
}

async function waitForProcessingBlock(
  control,
  selector,
  description,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  let diagnostics = null

  while (Date.now() - startedAt < timeoutMs) {
    await control.command('expandProcessingSummaries', 'body')
    const targetCount = Number(await control.command('getElementCount', selector))
    diagnostics = {
      targetCount,
      finalProcessingExpandedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="final-processing-toggle"][aria-expanded="true"]'
        )
      ),
      finalProcessingCollapsedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="final-processing-toggle"][aria-expanded="false"]'
        )
      ),
      processingSummaryExpandedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="processing-summary-toggle"][aria-expanded="true"]'
        )
      ),
      processingSummaryCollapsedCount: Number(
        await control.command(
          'getElementCount',
          '[data-testid="processing-summary-toggle"][aria-expanded="false"]'
        )
      ),
      processingBlockCount: Number(
        await control.command('getElementCount', '[data-processing-block-id]')
      ),
      processingLivePreviewCount: Number(
        await control.command('getElementCount', '[data-testid="processing-live-preview"]')
      ),
    }
    if (targetCount > 0) return diagnostics
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  const snapshot = await control.command('snapshot', 'body')
  await writeFile(
    join(resultDir, 'processing-block-timeout-diagnostics.json'),
    `${JSON.stringify({ description, selector, diagnostics, snapshot: JSON.parse(snapshot) }, null, 2)}\n`,
    'utf8'
  )
  throw new Error(
    `${description} did not render ${selector}; diagnostics: ${JSON.stringify(diagnostics)}`
  )
}

async function verifyViewImageProcessingBlock(control) {
  const viewImageBlockSelector = '[data-processing-block-id="wework-e2e-view-image"]'
  await waitForProcessingBlock(control, viewImageBlockSelector, 'The view_image processing block')
  await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
  await control.command(
    'waitFor',
    '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="false"]',
    { visible: true, stableMs: 300, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(
    control,
    '03-view-image-collapsed.png',
    '[data-testid="processing-live-preview"]'
  )
  await control.command(
    'click',
    '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle]'
  )
  await control.command('waitFor', '[data-testid="image-view-preview"]', {
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    '[data-processing-block-id="wework-e2e-view-image"] [data-tool-detail-toggle][aria-expanded="true"]',
    { stableMs: 500, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('scrollIntoView', '[data-testid="processing-live-preview"]')
  await control.command('waitFor', '[data-testid="image-view-preview"]', {
    visible: true,
    stableMs: 500,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(
    control,
    '04-view-image-expanded.png',
    '[data-testid="processing-live-preview"]'
  )
}

function distanceFromBottom(metrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

async function openBottomWorkspaceTerminal(control, description) {
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  const snapshot = await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    `${description} did not start the terminal directly`,
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    snapshot.testIds.includes('workspace-ide-card'),
    false,
    `${description} exposed IDE in the bottom panel`
  )
  return snapshot
}

async function closeBottomWorkspacePanel(control) {
  await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The bottom workspace panel did not close',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

function processGroup(snapshot, groupName) {
  return snapshot.processMemory.groups.find(group => group.group === groupName) ?? null
}

async function captureMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  const webContent = processGroup(snapshot, 'webkit-webcontent')
  assert.ok(webContent, 'The Wework WebContent process was missing from the memory snapshot')
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: webContent.rss_kib,
    physicalFootprintKiB: webContent.physical_footprint_kib,
    pids: webContent.pids,
  }
}

async function captureTotalMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: snapshot.processMemory.groups.reduce((total, group) => total + group.rss_kib, 0),
    physicalFootprintKiB: snapshot.processMemory.groups.reduce(
      (total, group) => total + group.physical_footprint_kib,
      0
    ),
    groups: snapshot.processMemory.groups,
  }
}

async function waitForNewTaskRow(
  control,
  knownTaskRows,
  expectedText,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(
      testId => testId.startsWith('runtime-local-task-row-') && !knownTaskRows.has(testId)
    )
    for (const testId of candidates) {
      const rowText = await control.command('getText', `[data-testid="${testId}"]`)
      if (rowText.includes(expectedText)) return testId
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The sidebar did not expose a task row for ${expectedText}`)
}

async function createCheckpointTaskFixture(control, composerSelector) {
  const knownTaskRows = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('checkpoint_task')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await sendPrompt(control, composerSelector, CHECKPOINT_TASK_PROMPT)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  return waitForNewTaskRow(control, knownTaskRows, 'WEWORK_DESKTOP_E2E_CHECKPOINT_TASK')
}

async function verifyPriorityFilter({ composerSelector, control }) {
  let requestInputResponseReleased = false
  control.setScenario('request_user_input')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await ensurePlanMode(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    REQUEST_USER_INPUT_PROMPT,
    'request_user_input'
  )

  const requestInputDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  const requestInputTaskId = requestInputDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(requestInputTaskId, 'The priority-filter fixture did not expose its runtime task ID')
  const requestInputTaskRowTestId = `runtime-local-task-row-${requestInputTaskId}`
  await control.command('waitFor', `[data-testid="${requestInputTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  try {
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('press', 'body', { key: 'Escape' })
    await captureVerificationScreenshot(control, 'priority-filter-01-background-task.png')

    await control.command('click', '[data-testid="runtime-priority-filter-button"]')
    await control.command('waitFor', '[data-testid="runtime-priority-section"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `[data-testid="runtime-priority-section"] [data-testid="${requestInputTaskRowTestId}"]`,
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const filteredSidebarSnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="desktop-sidebar"]')
    )
    assert.equal(
      filteredSidebarSnapshot.testIds.includes('new-chat-button'),
      true,
      'Priority filtering removed the primary new-task navigation'
    )
    assert.equal(
      filteredSidebarSnapshot.testIds.includes('plugins-button'),
      true,
      'Priority filtering removed the plugins navigation'
    )
    assert.equal(
      filteredSidebarSnapshot.testIds.includes('projects-section-toggle'),
      false,
      'Priority filtering kept the regular project list visible'
    )
    await captureVerificationScreenshot(control, 'priority-filter-02-filtered-sidebar.png')

    await withTimeout(
      control.releaseRequestUserInputResponse(),
      DEFAULT_STEP_TIMEOUT_MS,
      'Timed out releasing the priority-filter request-user-input response'
    )
    requestInputResponseReleased = true
    await control.command('click', `[data-testid="${requestInputTaskRowTestId}"]`)
    await control.command('waitFor', '[data-testid="request-user-input-card"]', {
      text: REQUEST_USER_INPUT_QUESTION,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: REQUEST_USER_INPUT_COMPLETION_TEXT,
      visible: true,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'waitFor',
      `[data-testid="runtime-priority-list"] [data-testid="${requestInputTaskRowTestId}"]`,
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await captureVerificationScreenshot(
      control,
      'priority-filter-03-handled-task-stays-priority.png'
    )

    await control.command('press', 'body', { key: 'Meta+Alt+U' })
    await control.command('waitFor', '[data-testid="projects-section-toggle"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('press', 'body', { key: 'Meta+Alt+U' })
    await control.command(
      'waitFor',
      `[data-testid^="runtime-priority-recent-list-"] [data-testid="${requestInputTaskRowTestId}"]`,
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const reopenedPrioritySnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="runtime-priority-section"]')
    )
    assert.equal(
      reopenedPrioritySnapshot.testIds.includes('runtime-priority-empty'),
      true,
      'Reopening the priority filter left the handled task in the Priority group'
    )
    await captureVerificationScreenshot(control, 'priority-filter-04-reopened-task-in-recent.png')

    await control.command('press', 'body', { key: 'Meta+Alt+U' })
    await control.command('waitFor', '[data-testid="projects-section-toggle"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const restoredSidebarSnapshot = JSON.parse(
      await control.command('snapshot', '[data-testid="desktop-sidebar"]')
    )
    assert.equal(
      restoredSidebarSnapshot.testIds.includes('runtime-priority-section'),
      false,
      'The priority shortcut did not restore the regular sidebar'
    )
    await captureVerificationScreenshot(control, 'priority-filter-05-shortcut-restored-sidebar.png')
  } finally {
    if (!requestInputResponseReleased) {
      try {
        await withTimeout(
          control.releaseRequestUserInputResponse(),
          DEFAULT_STEP_TIMEOUT_MS,
          'Timed out releasing the priority-filter request-user-input response'
        )
      } catch (releaseError) {
        console.warn(
          `[desktop-e2e] priority-filter cleanup release failed: ${String(releaseError)}`
        )
      }
    }
  }
  await control.command('click', '[data-testid="cancel-plan-mode-button"]')
}

async function verifyBackgroundCompletionRestore({
  composerSelector,
  control,
  otherTaskRowTestId,
}) {
  const knownTaskRows = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('background_completion_restore')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    'background_completion_restore'
  )
  await withTimeout(
    control.awaitBackgroundCompletionRestoreResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the background-completion response to start'
  )
  const taskRowTestId = await waitForNewTaskRow(
    control,
    knownTaskRows,
    'WEWORK_DESKTOP_E2E_BACKGROUND_COMPLETION_RESTORE'
  )
  const taskId = taskRowTestId.replace('runtime-local-task-row-', '')
  const runningTaskTestId = `runtime-local-task-running-${taskId}`
  await control.command('waitFor', `[data-testid="${runningTaskTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  control.releaseBackgroundCompletionRestoreResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background-completion task did not settle while another conversation was active'
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'The completed background conversation did not finish hydrating after switching back'
  )
  const restoredSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_COMPLETION_RESTORE_TEXT) &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching back restored the completed background turn as stopped or streaming',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    countTextOccurrences(restoredSnapshot.text, BACKGROUND_COMPLETION_RESTORE_TEXT),
    1,
    'Switching back duplicated the completed background assistant message'
  )

  control.setScenario('background_follow_up_restore')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    'background_follow_up_restore'
  )
  await withTimeout(
    control.awaitBackgroundFollowUpRestoreResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the background follow-up response to start'
  )
  await control.command('waitFor', `[data-testid="${runningTaskTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${otherTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  control.releaseBackgroundFollowUpRestoreResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background follow-up did not settle while another conversation was active'
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'The background follow-up did not finish hydrating after switching back'
  )
  const followUpSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_COMPLETION_RESTORE_TEXT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_PROMPT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_TEXT) &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching back lost or unsettled the completed background follow-up',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const conversationMessageSelector = [
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
  ].join(', ')
  const followUpMessagesText = await control.command('getText', conversationMessageSelector)
  assertConversationTextOrder(followUpMessagesText, [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ])
  for (const text of [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ]) {
    assert.equal(
      countTextOccurrences(followUpMessagesText, text),
      1,
      `Switching back duplicated "${text}"`
    )
  }

  const readyCountBeforeReload = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await withTimeout(
    control.awaitReadyAfter(readyCountBeforeReload),
    WORKBENCH_READY_TIMEOUT_MS,
    'The reloaded Wework WebView did not reconnect to the desktop controller'
  )
  await control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === taskId &&
      snapshot.pane?.transcript?.loading === false,
    'Reloading did not restore the completed background conversation'
  )
  const reloadedSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(BACKGROUND_COMPLETION_RESTORE_TEXT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_PROMPT) &&
      snapshot.text.includes(BACKGROUND_FOLLOW_UP_RESTORE_TEXT) &&
      !snapshot.testIds.includes('assistant-stopped-notice') &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Reloading lost or unsettled the completed background turns',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const reloadedMessagesText = await control.command('getText', conversationMessageSelector)
  assertConversationTextOrder(reloadedMessagesText, [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ])
  for (const text of [
    BACKGROUND_COMPLETION_RESTORE_PROMPT,
    BACKGROUND_COMPLETION_RESTORE_TEXT,
    BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
    BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  ]) {
    assert.equal(
      countTextOccurrences(reloadedMessagesText, text),
      1,
      `Reloading duplicated "${text}"`
    )
  }
}

async function waitForTaskRowByText(control, expectedText) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const candidates = snapshot.testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
    for (const testId of candidates) {
      const rowText = await control.command('getText', `[data-testid="${testId}"]`)
      if (rowText.includes(expectedText)) return testId
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The sidebar did not expose a task row containing ${expectedText}`)
}

async function verifyRunningFollowUpFork({
  composerSelector,
  control,
  executorHome,
  sourceTaskRowTestId,
}) {
  const taskRowsBeforeFork = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  control.setScenario('running_fork_follow_up')
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    RUNNING_FORK_FOLLOW_UP_PROMPT,
    'running_fork_follow_up'
  )
  await control.command('waitFor', '[data-testid="pause-response-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const firstTurnForkButtonSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="fork-message-button"]`
  await control.command('scrollIntoView', firstTurnForkButtonSelector)
  await captureVerificationScreenshot(control, 'running-follow-up-fork-01-streaming.png')

  try {
    await control.command(
      'clickDescendantInElementWithText',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        target: '[data-testid="fork-message-button"]',
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    const forkTaskRowTestId = await waitForNewTaskRow(control, taskRowsBeforeFork, '', 15_000)
    assert.notEqual(
      forkTaskRowTestId,
      sourceTaskRowTestId,
      'Forking the first turn reused the running source task'
    )

    const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
    const forkTaskId = forkTaskRowTestId.replace('runtime-local-task-row-', '')
    const runtimeIndex = JSON.parse(
      await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    )
    assert.equal(
      runtimeIndex.tasks[forkTaskId]?.parent?.taskId,
      sourceTaskId,
      'Forking during a follow-up did not persist the source task relationship'
    )
    assert.ok(
      runtimeIndex.tasks[forkTaskId]?.parent?.lastTurnId,
      'Forking during a follow-up did not persist the selected first turn'
    )
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    const forkSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    assert.equal(
      forkSnapshot.text.includes(RUNNING_FORK_FOLLOW_UP_PROMPT),
      false,
      'The forked task included the in-flight follow-up after the selected turn'
    )
    await captureVerificationScreenshot(control, 'running-follow-up-fork-02-target-open.png')
  } finally {
    control.releaseRunningForkFollowUpResponse()
  }

  await ensureTaskRowVisible(control, sourceTaskRowTestId)
  await control.command('click', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: RUNNING_FORK_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const settledRuntimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  assert.equal(
    Object.hasOwn(settledRuntimeIndex.tasks[sourceTaskId] ?? {}, 'turn_status'),
    false,
    'The completed source follow-up leaked process-local turn status into the runtime index'
  )
}

async function verifyCompletedTurnFork({
  composerSelector,
  control,
  executorHome,
  sourceTaskRowTestId,
  workspacePath,
}) {
  const taskRowsBeforeFork = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  const firstTurnForkButtonSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-testid="fork-message-button"]`
  await control.command('scrollIntoView', firstTurnForkButtonSelector)
  await control.command('waitFor', firstTurnForkButtonSelector, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-01-source-ready.png')
  await control.command(
    'clickDescendantInElementWithText',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      target: '[data-testid="fork-message-button"]',
      text: COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const forkTaskRowTestId = await waitForNewTaskRow(control, taskRowsBeforeFork, '')
  assert.notEqual(
    forkTaskRowTestId,
    sourceTaskRowTestId,
    'Forking reused the source task instead of creating an independent task'
  )
  const sourceTaskId = sourceTaskRowTestId.replace('runtime-local-task-row-', '')
  const forkTaskId = forkTaskRowTestId.replace('runtime-local-task-row-', '')
  const runtimeIndex = JSON.parse(
    await readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
  )
  assert.equal(
    runtimeIndex.tasks[sourceTaskId]?.workspace_path,
    workspacePath,
    'The source task did not use the selected project workspace'
  )
  assert.equal(
    runtimeIndex.tasks[forkTaskId]?.workspace_path,
    workspacePath,
    'The forked task did not inherit the source workspace'
  )
  assert.equal(
    runtimeIndex.tasks[forkTaskId]?.parent?.taskId,
    sourceTaskId,
    'The backend did not persist the fork parent relationship'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-02-target-open.png')

  control.setScenario('fork_follow_up')
  const forkFollowUpRequest = await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    FORK_FOLLOW_UP_PROMPT,
    'fork_follow_up'
  )
  assert.ok(
    JSON.stringify(forkFollowUpRequest.body).includes(FORK_FOLLOW_UP_PROMPT),
    'The forked task did not accept an independent follow-up'
  )
  assert.equal(
    JSON.stringify(forkFollowUpRequest.body).includes(FORK_ENCRYPTED_CONTENT),
    false,
    'The forked request forwarded opaque encrypted reasoning history'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: FORK_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'completed-turn-fork-03-follow-up-complete.png')

  await control.command('click', `[data-testid="${sourceTaskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const sourceSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.ok(
    !sourceSnapshot.text.includes(FORK_FOLLOW_UP_PROMPT) &&
      !sourceSnapshot.text.includes(FORK_FOLLOW_UP_COMPLETION_TEXT),
    'The fork follow-up mutated the source task transcript'
  )
  await captureVerificationScreenshot(control, 'completed-turn-fork-04-source-unchanged.png')
}

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
}

async function verifyConcurrentTaskMemory({ composerSelector, control }) {
  assert.equal(process.platform, 'darwin', 'Concurrent memory E2E currently requires macOS')
  control.setScenario('concurrent_memory')
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
        limitPhysicalFootprintKiB: CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB,
        peak,
        samples,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  assert.ok(
    peak.physicalFootprintKiB < CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB,
    `Wework physical footprint reached ${peak.physicalFootprintKiB} KiB with ten concurrent tasks`
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
  const settledDomNodeCount = Math.max(...settledWindow.map(sample => sample.domNodeCount))

  await writeFile(
    join(resultDir, 'memory-growth.json'),
    `${JSON.stringify(
      {
        limits: {
          maxPeakGrowthKiB: MEMORY_MAX_PEAK_GROWTH_KIB,
          maxSettledGrowthKiB: MEMORY_MAX_SETTLED_GROWTH_KIB,
          maxSettledDomNodeCount: MEMORY_MAX_SETTLED_DOM_NODE_COUNT,
        },
        summary: {
          peakGrowthKiB,
          settledGrowthKiB,
          settledRangeKiB,
          peakDomNodeCount,
          settledDomNodeCount,
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
    settledDomNodeCount <= MEMORY_MAX_SETTLED_DOM_NODE_COUNT,
    `WebContent DOM retained ${settledDomNodeCount} nodes after rendering the long response`
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

async function waitForFolderPathReady(control, expectedPath) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue === expectedPath && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`The device folder picker did not finish loading ${expectedPath}`)
}

async function waitForFolderPickerInitialized(control) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const inputValue = await control.command('getValue', '[data-testid="device-folder-path-input"]')
    const directoryText = await control.command(
      'getText',
      '[data-testid="device-folder-directory-list"]'
    )
    if (inputValue.length > 0 && !/Loading directories|正在加载目录/.test(directoryText)) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('The device folder picker did not finish loading its initial path')
}

async function waitForControlValue(
  control,
  selector,
  expected,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if ((await control.command('getValue', selector)) === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

function normalizeComposerText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function waitForControlValueIncludes(
  control,
  selector,
  expectedSubstring,
  message,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const expected = normalizeComposerText(expectedSubstring)
  const startedAt = Date.now()
  let lastValue = ''
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await control.command('getValue', selector)
    if (normalizeComposerText(lastValue).includes(expected)) return lastValue
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastValue)}`)
}

async function waitForControlSelectionOffset(control, selector, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    if (Number(await control.command('getSelectionOffset', selector)) === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForPersistedComposerInput(control, expected, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (snapshot.workbench?.composer?.currentInputLength === expected.length) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForWorkbenchTask(control, taskId, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    if (snapshot.workbench?.currentRuntimeTask?.taskId === taskId) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function waitForWorkbenchDebugState(control, predicate, message) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    lastSnapshot = snapshot
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: ${JSON.stringify(lastSnapshot)}`)
}

async function captureVerificationScreenshot(control, name, selector = 'body') {
  if (
    process.env.WEWORK_E2E_SCREENSHOTS === 'final' &&
    !name.endsWith('04-task-completed-after-reopen.png')
  ) {
    return null
  }
  const screenshotPath = join(resultDir, name)
  if (process.platform === 'linux') {
    await runChecked('import', ['-window', 'root', screenshotPath])
    return screenshotPath
  }
  let dataUrl
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      dataUrl = await control.command('capture', selector, { timeoutMs: 90_000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    }
  }
  const prefix = 'data:image/png;base64,'
  assert.ok(dataUrl.startsWith(prefix), 'Desktop screenshot did not return PNG data')
  await writeFile(screenshotPath, Buffer.from(dataUrl.slice(prefix.length), 'base64'))
  return screenshotPath
}

async function verifyWorkspaceDocumentTabs(control) {
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const initialBoardTabIds = workspaceTabIds(initialSnapshot, 'board')

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="workspace-tab-add-board"]')
  const openedSnapshot = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'board').length === initialBoardTabIds.length + 1,
    'Adding a project-space document tab did not create a distinct tab'
  )
  const addedBoardTabId = workspaceTabIds(openedSnapshot, 'board').find(
    testId => !initialBoardTabIds.includes(testId)
  )
  assert.ok(addedBoardTabId, 'The newly added project-space tab could not be identified')
  const addedBoardTabSuffix = addedBoardTabId.slice('workspace-tab-board-'.length)
  await control.command(
    'waitFor',
    `[data-testid="workspace-tab-select-board-${addedBoardTabSuffix}"][aria-selected="true"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-tabs-01-project-spaces-active.png')

  await control.command('click', '[data-testid^="workspace-tab-select-task-"]')
  await control.command('waitFor', '[data-tab-kind="task"][aria-selected="true"]', {
    text: '任务',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="workspace-tab-close-board-${addedBoardTabSuffix}"]`)
  await waitForSnapshot(
    control,
    snapshot => {
      const boardTabIds = workspaceTabIds(snapshot, 'board')
      return (
        !boardTabIds.includes(addedBoardTabId) &&
        initialBoardTabIds.every(testId => boardTabIds.includes(testId))
      )
    },
    'Closing the added project-space document tab did not preserve the original tabs'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-02-task-restored.png')
}

async function configureDefaultProjectSpaceAssociation(control, localProjectId) {
  const taskTabTestId = await control.command(
    'getAttribute',
    '[data-tab-kind="task"][aria-selected="true"]',
    { value: 'data-testid' }
  )
  assert.ok(taskTabTestId, 'The active task tab identity was unavailable before association setup')

  await control.command('click', '[data-testid^="workspace-tab-select-board-"]')
  await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const boardSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const createSelector = boardSnapshot.testIds.includes('cloud-projects-home-create')
    ? '[data-testid="cloud-projects-home-create"]'
    : '[data-testid="cloud-project-add"]'
  await control.command('click', createSelector)
  await control.command('waitFor', '[data-testid="cloud-project-name"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="cloud-project-name"]', {
    value: 'Task Follow-up Board',
  })
  await control.command('click', '[data-testid="cloud-project-location-local"]')
  await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]')
  await control.command('waitFor', '[data-testid="cloud-project-manage-view"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'project-space-created-for-local-project.png')
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="project-menu-${localProjectId}"]`)
  await control.command('click', `[data-testid="edit-project-${localProjectId}"]`)
  await control.command('waitFor', '[data-testid="local-project-edit-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('select', '[data-testid="local-project-auto-join-space-select"]', {
    by: 'label',
    value: 'Task Follow-up Board',
  })
  await control.command('clickWhenEnabled', '[data-testid="save-local-project-button"]')
  await control.command('waitFor', '[data-testid="project-space-context-pill"]', {
    text: '加入看板 · Task Follow-up Board',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('waitFor', '[data-testid="add-project-space-context-button"]', {
    text: 'Task Follow-up Board',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="add-project-space-context-button"]')
  await control.command('waitFor', '[data-testid^="add-context-cloud-project-space-"]', {
    text: 'Task Follow-up Board',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('press', 'body', { key: 'Escape' })
  return taskTabTestId
}

async function verifyExplicitlyTrackedTask(control, taskTabTestId) {
  await control.command('click', '[data-testid^="workspace-tab-select-board-"]')
  await control.command('waitFor', '[data-testid="cloud-project-board-view"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="cloud-project-board-view"]')
  await control.command('waitFor', '[data-testid="cloud-todo-column-in_review"]', {
    text: 'WEWORK_DESKTOP_E2E_TASK',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'project-space-selected-task-in-review.png')
  await control.command('click', `[data-testid="${taskTabTestId}"]`)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

function workspaceTabIds(snapshot, kind) {
  return snapshot.testIds.filter(testId => testId.startsWith(`workspace-tab-${kind}-`))
}

function allWorkspaceTabIds(snapshot) {
  return ['task', 'board', 'agent', 'auxiliary'].flatMap(kind => workspaceTabIds(snapshot, kind))
}

async function waitForAttribute(control, selector, name, expected, message) {
  const startedAt = Date.now()
  let actual = null
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    actual = await control.command('getAttribute', selector, { value: name })
    if (actual === expected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`${message}: expected ${name}=${expected}, received ${actual}`)
}

async function verifyWorkspaceTabIsolation(control) {
  await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const initial = JSON.parse(await control.command('snapshot', 'body'))
  const initialTaskIds = workspaceTabIds(initial, 'task')
  const initialBoardIds = workspaceTabIds(initial, 'board')
  const initialAgentIds = workspaceTabIds(initial, 'agent')
  assert.equal(initialTaskIds.length, 1, 'The titlebar did not start with one task tab')
  assert.equal(initialBoardIds.length, 1, 'The titlebar did not start with one project-space tab')
  assert.equal(initialAgentIds.length, 1, 'The titlebar did not start with one Agent tab')
  assert.equal(
    initialTaskIds.length + initialBoardIds.length + initialAgentIds.length,
    3,
    'The titlebar did not start with exactly three product tabs'
  )

  const firstTaskId = initialTaskIds[0].slice('workspace-tab-'.length)
  const firstTaskContent = `[data-testid="workspace-tab-content-${firstTaskId}"]`
  const firstTaskComposer = `${firstTaskContent} [data-testid="chat-message-input"]`
  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', firstTaskComposer, { value: '第一个任务标签草稿' })

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const withSecondTask = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'task').length === 2,
    'The explicit new-task action did not create a second task tab'
  )
  const secondTaskTestId = workspaceTabIds(withSecondTask, 'task').find(
    testId => !initialTaskIds.includes(testId)
  )
  assert.ok(secondTaskTestId, 'The second task tab identity was not observable')
  const secondTaskId = secondTaskTestId.slice('workspace-tab-'.length)
  const secondTaskContent = `[data-testid="workspace-tab-content-${secondTaskId}"]`
  const secondTaskComposer = `${secondTaskContent} [data-testid="chat-message-input"]`
  await control.command('waitFor', secondTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', secondTaskComposer),
    '',
    'A new task tab inherited the first tab draft'
  )
  await control.command('fill', secondTaskComposer, { value: '第二个任务标签草稿' })
  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', firstTaskComposer),
    '第一个任务标签草稿',
    'Editing the second task tab mutated or discarded the first task tab draft'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${secondTaskId}"]`)
  await control.command('waitFor', secondTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getValue', secondTaskComposer),
    '第二个任务标签草稿',
    'Switching away from the second task tab lost its draft'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', firstTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-01-task-drafts.png')

  const firstBoardId = initialBoardIds[0].slice('workspace-tab-'.length)
  const firstBoardContent = `[data-testid="workspace-tab-content-${firstBoardId}"]`
  const firstBoardWorkspace = `${firstBoardContent} [data-testid="cloud-todo-workspace"]`
  await control.command('click', `[data-testid="workspace-tab-select-${firstBoardId}"]`)
  await control.command('waitFor', firstBoardWorkspace, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    firstBoardWorkspace,
    'data-sidebar-collapsed',
    'false',
    'The first project-space tab did not start expanded'
  )
  await control.command('click', `${firstBoardContent} [data-testid="cloud-todo-collapse-sidebar"]`)
  await waitForAttribute(
    control,
    firstBoardWorkspace,
    'data-sidebar-collapsed',
    'true',
    'The first project-space tab did not preserve its local sidebar state'
  )

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-board"]')
  const withSecondBoard = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'board').length === 2,
    'The explicit new-project-space action did not create a second tab'
  )
  const secondBoardTestId = workspaceTabIds(withSecondBoard, 'board').find(
    testId => !initialBoardIds.includes(testId)
  )
  assert.ok(secondBoardTestId, 'The second project-space tab identity was not observable')
  const secondBoardId = secondBoardTestId.slice('workspace-tab-'.length)
  const secondBoardContent = `[data-testid="workspace-tab-content-${secondBoardId}"]`
  const secondBoardWorkspace = `${secondBoardContent} [data-testid="cloud-todo-workspace"]`
  await control.command('waitFor', secondBoardWorkspace, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    secondBoardWorkspace,
    'data-sidebar-collapsed',
    'false',
    'A new project-space tab inherited the first tab sidebar state'
  )
  assert.equal(
    await control.command('getAttribute', firstBoardWorkspace, {
      value: 'data-sidebar-collapsed',
    }),
    'true',
    'Opening a second project-space tab reset the first tab state'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${firstBoardId}"]`)
  await control.command('waitFor', firstBoardWorkspace, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForAttribute(
    control,
    firstBoardWorkspace,
    'data-sidebar-collapsed',
    'true',
    'Switching back did not restore the first project-space tab state'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-02-project-spaces.png')

  const firstAgentId = initialAgentIds[0].slice('workspace-tab-'.length)
  const firstAgentContent = `[data-testid="workspace-tab-content-${firstAgentId}"]`
  const firstAgentWebview = `${firstAgentContent} [data-testid="app-iframe-wegent"]`
  await control.command('click', `[data-testid="workspace-tab-select-${firstAgentId}"]`)
  await control.command('waitFor', firstAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', firstAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    firstAgentId,
    'The first Agent webview was not bound to its tab identity'
  )
  const agentStorageKey = 'wework-e2e-agent-storage'
  const agentStorageValue = `persisted-${Date.now()}`
  await control.command('setEmbeddedBrowserLocalStorageItem', 'body', {
    value: JSON.stringify({
      key: agentStorageKey,
      label: `app-wegent-${firstAgentId}`,
      value: agentStorageValue,
    }),
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getEmbeddedBrowserLocalStorageItem', 'body', {
      value: JSON.stringify({
        key: agentStorageKey,
        label: `app-wegent-${firstAgentId}`,
      }),
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    }),
    agentStorageValue,
    'The first Agent webview did not retain its localStorage write'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 3000))
  await control.command('click', `[data-testid="workspace-tab-close-${firstAgentId}"]`)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`workspace-tab-${firstAgentId}`),
    'Closing the first Agent tab did not remove its webview host'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-agent"]')
  const withSecondAgent = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'agent').length === 1,
    'The explicit new-Agent action did not reopen an Agent tab'
  )
  const secondAgentTestId = workspaceTabIds(withSecondAgent, 'agent')[0]
  assert.ok(secondAgentTestId, 'The second Agent tab identity was not observable')
  const secondAgentId = secondAgentTestId.slice('workspace-tab-'.length)
  const secondAgentContent = `[data-testid="workspace-tab-content-${secondAgentId}"]`
  const secondAgentWebview = `${secondAgentContent} [data-testid="app-iframe-wegent"]`
  await control.command('waitFor', secondAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', secondAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    secondAgentId,
    'The second Agent tab reused the first webview identity'
  )
  assert.equal(
    await control.command('getEmbeddedBrowserLocalStorageItem', 'body', {
      value: JSON.stringify({
        key: agentStorageKey,
        label: `app-wegent-${secondAgentId}`,
      }),
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    }),
    agentStorageValue,
    'Reopening Wegent did not restore its persisted localStorage'
  )

  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-agent"]')
  const withThirdAgent = await waitForSnapshot(
    control,
    snapshot => workspaceTabIds(snapshot, 'agent').length === 2,
    'The explicit new-Agent action did not create an independent Agent tab'
  )
  const thirdAgentTestId = workspaceTabIds(withThirdAgent, 'agent').find(
    testId => testId !== secondAgentTestId
  )
  assert.ok(thirdAgentTestId, 'The third Agent tab identity was not observable')
  const thirdAgentId = thirdAgentTestId.slice('workspace-tab-'.length)
  const thirdAgentContent = `[data-testid="workspace-tab-content-${thirdAgentId}"]`
  const thirdAgentWebview = `${thirdAgentContent} [data-testid="app-iframe-wegent"]`
  await control.command('waitFor', thirdAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', thirdAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    thirdAgentId,
    'The third Agent tab reused the reopened webview identity'
  )
  const agentSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    agentSnapshot.testIds.includes(`workspace-tab-content-${secondAgentId}`) &&
      agentSnapshot.testIds.includes(`workspace-tab-content-${thirdAgentId}`),
    'Switching Agent tabs unmounted one of the webview hosts'
  )
  await control.command('click', `[data-testid="workspace-tab-select-${secondAgentId}"]`)
  await control.command('waitFor', secondAgentWebview, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', thirdAgentWebview, {
      value: 'data-workspace-tab-id',
    }),
    thirdAgentId,
    'The hidden Agent webview host was recreated or detached after switching tabs'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-03-agent-webviews.png')

  await control.command('click', `[data-testid="workspace-tab-select-${firstTaskId}"]`)
  await control.command('waitFor', `${firstTaskContent} [data-testid="plugins-button"]`, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const tabCountBeforeOrdinaryNavigation = allWorkspaceTabIds(
    JSON.parse(await control.command('snapshot', 'body'))
  ).length
  await control.command('click', `${firstTaskContent} [data-testid="plugins-button"]`)
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const afterOrdinaryNavigation = JSON.parse(await control.command('snapshot', 'body'))
  assert.equal(
    allWorkspaceTabIds(afterOrdinaryNavigation).length,
    tabCountBeforeOrdinaryNavigation,
    'Ordinary in-task navigation opened an extra document tab'
  )
  assert.ok(
    afterOrdinaryNavigation.testIds.includes(`workspace-tab-${firstTaskId}`),
    'Ordinary navigation replaced the active tab identity instead of its content'
  )
  assert.equal(
    await control.command('getAttribute', `[data-testid="workspace-tab-select-${firstTaskId}"]`, {
      value: 'data-tab-kind',
    }),
    'auxiliary',
    'Ordinary navigation did not replace the active tab kind in place'
  )
  await captureVerificationScreenshot(control, 'workspace-tabs-isolation-04-route-replacement.png')

  await control.command('press', `[data-testid="workspace-tab-select-${secondTaskId}"]`, {
    key: 'Shift+F10',
  })
  await control.command('waitFor', '[data-testid="workspace-tab-context-menu"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const readyCountBeforeDetach = control.readyCount
  try {
    await control.command('click', '[data-testid="workspace-tab-open-new-window"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  } catch (error) {
    if (!String(error).includes('replaced by a newer app session')) throw error
  }
  const detachedReady = await withTimeout(
    control.awaitReadyAfter(readyCountBeforeDetach),
    WORKBENCH_READY_TIMEOUT_MS,
    'The detached workspace window did not register its WebView'
  )
  assert.ok(
    detachedReady.windowLabel?.startsWith('workspace-'),
    `The detached tab registered an unexpected window: ${detachedReady.windowLabel}`
  )
  const detachedControl = {
    command: (...args) => control.commandForClient(detachedReady.clientId, ...args),
  }
  await detachedControl.command('waitFor', '[data-testid="workspace-tab-strip"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const detachedWindowSnapshot = JSON.parse(await detachedControl.command('snapshot', 'body'))
  assert.deepEqual(
    allWorkspaceTabIds(detachedWindowSnapshot),
    [`workspace-tab-${secondTaskId}`],
    'The detached window did not contain exactly the transferred task tab'
  )
  const detachedTaskComposer =
    `[data-testid="workspace-tab-content-${secondTaskId}"] ` + '[data-testid="chat-message-input"]'
  await detachedControl.command('waitFor', detachedTaskComposer, {
    visible: true,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    await detachedControl.command('getValue', detachedTaskComposer),
    '第二个任务标签草稿',
    'Detaching the task tab lost its unsent draft'
  )
  await captureVerificationScreenshot(
    detachedControl,
    'workspace-tabs-isolation-05-detached-window.png'
  )

  const sourceStorageKey = 'wework.workspaceTabs.v2:main'
  const sourceTabRemovalStartedAt = Date.now()
  let sourceTabs = []
  while (Date.now() - sourceTabRemovalStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const raw = await control.commandForWindow('main', 'getLocalStorageItem', 'body', {
      value: sourceStorageKey,
    })
    sourceTabs = raw ? (JSON.parse(raw).tabs ?? []) : []
    if (!sourceTabs.some(tab => tab.id === secondTaskId)) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.equal(
    sourceTabs.some(tab => tab.id === secondTaskId),
    false,
    'The transferred task tab remained open in the source window'
  )
  control.activateWindow('main')
}

async function verifyCloudWorkPage(control) {
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', '[data-testid="cloud-work-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    snapshot.testIds.includes('cloud-work-devices-section'),
    'The cloud work page did not render its device status section'
  )
  assert.ok(
    snapshot.testIds.includes('cloud-work-projects-section'),
    'The cloud work page did not render its cloud projects section'
  )
  assert.equal(
    snapshot.testIds.includes('general-settings-page'),
    false,
    'The cloud work route unexpectedly opened general settings'
  )
  await captureVerificationScreenshot(control, '00-cloud-work-page.png')
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function initializeBlankCodexHome({ codexHome, control }) {
  const configPath = join(codexHome, 'config.toml')
  await control.command('waitFor', '[data-testid="codex-home-initializer-dialog"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'plugins-00-blank-codex-home.png')
  await control.command('click', '[data-testid="codex-home-initializer-create-button"]')
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.equal(
    (await readFile(configPath, 'utf8')).includes('desktop-e2e-native-home-marker'),
    false,
    'Creating a blank Codex home unexpectedly migrated native Codex content'
  )
}

async function waitForBundledMarketplaceRegistration(codexHome) {
  const configPath = join(codexHome, 'config.toml')
  const startedAt = Date.now()
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    if (await pathExists(configPath)) {
      const config = await readFile(configPath, 'utf8')
      if (
        config.includes('[marketplaces.wework-personal]') &&
        config.includes('source_type = "local"')
      ) {
        return
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error('The bundled local plugin marketplace was not registered in the background')
}

async function verifyStartupIgnoresBlockedCodexNetwork({
  blockingNetworkProxy,
  control,
  restartDesktopApp,
}) {
  const requestCountBeforeRestart = blockingNetworkProxy.requestCount()
  const modelRequestCountBeforeRestart = control.modelRequests.length
  await control.command('storeLocalProxyUrl', 'body', { value: blockingNetworkProxy.url })
  await restartDesktopApp()
  const [blockedRequest] = await Promise.all([
    blockingNetworkProxy.waitForRequestMatchingAfter(
      requestCountBeforeRestart,
      STARTUP_NETWORK_PROBE_REQUEST_PATTERN,
      DEFAULT_STEP_TIMEOUT_MS
    ),
    control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }),
  ])
  assert.match(
    blockedRequest,
    /^(CONNECT|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) /,
    'The blocking proxy did not capture a Codex startup request'
  )
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    snapshot.testIds.includes('desktop-workbench-main'),
    'Blocked Codex network traffic prevented the workbench from becoming usable'
  )
  const executorStatus = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.equal(
    executorStatus.ready,
    true,
    'The local executor was not ready after Codex initialize'
  )
  assert.ok(
    Number.isFinite(executorStatus.codexInitializeElapsedMs),
    'The local executor did not report the Codex initialize duration'
  )
  assert.ok(
    executorStatus.codexInitializeElapsedMs <= DEFAULT_STEP_TIMEOUT_MS,
    `Codex initialize took ${executorStatus.codexInitializeElapsedMs}ms with blocked network`
  )
  console.log(
    `Codex initialize completed in ${executorStatus.codexInitializeElapsedMs}ms while startup network remained blocked`
  )
  assert.equal(
    control.modelRequests.length,
    modelRequestCountBeforeRestart,
    'The workbench sent an agent model request while Codex was still starting'
  )

  blockingNetworkProxy.release()
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('setLocalProxyUrl', 'body', { value: '' })
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function verifyOfficialPluginSource(repositoryRoot) {
  const officialPluginRoot = join(repositoryRoot, 'plugins', OFFICIAL_PLUGIN_NAME)
  const officialPluginManifestPath = join(officialPluginRoot, '.codex-plugin', 'plugin.json')
  const officialPluginMcpPath = join(officialPluginRoot, '.mcp.json')
  const officialPluginSkillPath = join(
    officialPluginRoot,
    'skills',
    OFFICIAL_PLUGIN_SKILL_NAME,
    'SKILL.md'
  )
  const [pluginManifest, mcpManifest, skill] = await Promise.all([
    readFile(officialPluginManifestPath, 'utf8').then(JSON.parse),
    readFile(officialPluginMcpPath, 'utf8').then(JSON.parse),
    readFile(officialPluginSkillPath, 'utf8'),
  ])

  assert.equal(
    commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    OFFICIAL_PLUGIN_REVISION
  )
  assert.equal(pluginManifest.name, OFFICIAL_PLUGIN_NAME)
  assert.equal(pluginManifest.author?.name, 'OpenAI')
  assert.ok(
    pluginManifest.repository?.startsWith(OFFICIAL_PLUGIN_REPOSITORY_PREFIX),
    'The synced plugin manifest did not point to the official OpenAI plugin repository'
  )
  assert.equal(pluginManifest.skills, './skills/')
  assert.equal(pluginManifest.mcpServers, './.mcp.json')
  assert.ok(skill.includes(OFFICIAL_PLUGIN_SKILL_MARKER))
  assert.ok(
    Object.keys(mcpManifest.mcpServers ?? {}).includes('openai-api-key-local-confirmation'),
    'The official plugin did not declare its local MCP server'
  )
}

async function openMarketplacePluginActions(control, { pluginId, marketplaceName, displayName }) {
  const actionsSelector = `[data-testid="plugin-marketplace-actions-${pluginId}"]`
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  const marketplaceTabSelector = `[data-testid="plugins-marketplace-tab-${marketplaceName}"]`
  const snapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`)) {
    if (snapshot.testIds.includes('plugins-clear-marketplace-filters')) {
      await control.command('click', '[data-testid="plugins-clear-marketplace-filters"]')
    } else if (snapshot.testIds.includes('plugins-search-input')) {
      await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })
    }
    await control.command('waitFor', marketplaceTabSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('click', marketplaceTabSelector)
    await control.command('fill', '[data-testid="plugins-search-input"]', {
      value: displayName,
    })
    await control.command('waitFor', actionsSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  const actionsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!actionsSnapshot.testIds.includes(`plugin-marketplace-try-${pluginId}`)) {
    await control.command('click', actionsSelector)
  }
  await control.command('waitFor', trySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function installOfficialPluginFixture({
  codexHome,
  control,
  marketplacePath,
  modelServerUrl,
  repositoryPath,
  workspacePath,
}) {
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await verifyOfficialPluginSource(repositoryPath)

  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })

  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (initialSnapshot.testIds.includes('plugins-add-custom-marketplace-empty-button')) {
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-empty-button"]')
  } else if (initialSnapshot.testIds.includes('plugins-add-marketplace-button')) {
    await control.command('click', '[data-testid="plugins-add-marketplace-button"]')
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-button"]')
  } else {
    await control.command('click', '[data-testid="plugins-create-button"]')
    await control.command('click', '[data-testid="plugins-add-market-option"]')
  }
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', {
    value: OFFICIAL_PLUGIN_DISPLAY_NAME,
  })

  const pluginId = `${OFFICIAL_PLUGIN_MARKETPLACE_NAME}:${OFFICIAL_PLUGIN_NAME}@${OFFICIAL_PLUGIN_MARKETPLACE_NAME}`
  const rowTestId = `plugin-marketplace-row-${pluginId}`
  const installTestId = `plugin-marketplace-install-${pluginId}`
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('plugins-marketplace-dialog') &&
      snapshot.testIds.includes(rowTestId) &&
      snapshot.testIds.includes(installTestId),
    'The pinned OpenAI marketplace did not become installable',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'plugins-01-marketplace.png')

  await control.command('click', installSelector)
  await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(`plugins-installed-strip-item-${pluginId}`) ||
      snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The official plugin was not shown as installed after the real app-server request',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await openMarketplacePluginActions(control, {
    pluginId,
    marketplaceName: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
    displayName: OFFICIAL_PLUGIN_DISPLAY_NAME,
  })
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  assert.match(
    await control.command('getText', trySelector),
    /Try in chat|Start chat|在对话中试用|立即对话/,
    'The installed plugin did not expose its chat action'
  )
  await captureVerificationScreenshot(control, 'plugins-02-installed.png')

  const skillPath = await findFileBySuffix(
    join(codexHome, 'plugins', 'cache', OFFICIAL_PLUGIN_MARKETPLACE_NAME),
    join('skills', OFFICIAL_PLUGIN_SKILL_NAME, 'SKILL.md')
  )
  assert.ok(skillPath, 'The official plugin skill was not materialized in the isolated Codex home')
  assert.ok(
    skillPath.includes(`${OFFICIAL_PLUGIN_NAME}/`),
    'The discovered skill did not belong to the installed official plugin'
  )
  assert.ok(
    (await readFile(skillPath, 'utf8')).includes(OFFICIAL_PLUGIN_SKILL_MARKER),
    'The materialized official skill did not match the pinned OpenAI plugin content'
  )
  const codexConfig = await readFile(join(codexHome, 'config.toml'), 'utf8')
  assert.ok(
    codexConfig.includes(`model_provider = "${MODEL_PROVIDER_ID}"`) &&
      codexConfig.includes(`base_url = "${modelServerUrl}/v1"`),
    'Installing the official plugin discarded the isolated E2E model provider'
  )

  return { installSelector, pluginId, skillPath }
}

async function openOfficialPluginChat(control, installSelector) {
  const pluginId = installSelector
    .replace(/^\[data-testid="plugin-marketplace-install-/, '')
    .replace(/"\]$/, '')
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  const detailTrySelector = `[data-testid="plugin-detail-toggle-${pluginId}"]`
  const installedStripSelector = `[data-testid="plugins-installed-strip-item-${pluginId}"]`
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const pluginsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (pluginsSnapshot.testIds.includes(`plugins-installed-strip-item-${pluginId}`)) {
    await control.command('click', installedStripSelector)
    await control.command('waitFor', detailTrySelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    assert.match(
      await control.command('getText', detailTrySelector),
      /Try in chat|Start chat|在对话中试用|立即对话/,
      'The installed official plugin detail did not expose its chat action'
    )
    await control.command('click', detailTrySelector)
  } else {
    await openMarketplacePluginActions(control, {
      pluginId,
      marketplaceName: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
      displayName: OFFICIAL_PLUGIN_DISPLAY_NAME,
    })
    await control.command('click', trySelector)
  }
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(OFFICIAL_PLUGIN_DISPLAY_NAME),
    'Trying the installed official plugin did not place its reference in the composer',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function createOfficialPluginTask({ control, installSelector, skillPath }) {
  await openOfficialPluginChat(control, installSelector)
  await captureVerificationScreenshot(control, 'plugins-03-used-in-chat.png')
  control.officialPluginSkillPath = skillPath
  control.scenarioRequests.delete('official_plugin')
  control.setScenario('official_plugin')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: OFFICIAL_PLUGIN_SKILL_READY_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await assertMentionRenderedAsToken(control, {
    tokenSelector: '[data-testid="sent-plugin-token-OpenAI-Developers"]',
    tokenText: OFFICIAL_PLUGIN_DISPLAY_NAME,
    plainTextMention: `@${OFFICIAL_PLUGIN_NAME}`,
    errorLabel: 'The sent plugin reference degraded to its plain-text mention',
  })
  await control.awaitScenarioRequestCount('official_plugin', 2, WORKBENCH_READY_TIMEOUT_MS)
  const taskId = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
    ?.currentRuntimeTask?.taskId
  assert.ok(taskId, 'The official plugin conversation did not expose its task ID')
  return taskId
}

async function verifyPluginLifecycle({ control, fixture }) {
  await createOfficialPluginTask({
    control,
    installSelector: fixture.installSelector,
    skillPath: fixture.skillPath,
  })
  await sendPrompt(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    'Call the selected official plugin MCP server to validate an out-of-workspace env path.'
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: OFFICIAL_PLUGIN_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('official_plugin', 5, WORKBENCH_READY_TIMEOUT_MS)
  assert.equal(
    control.scenarioRequests.get('official_plugin')?.length,
    5,
    'The official plugin flow did not execute the expected skill-read, tool-search, and MCP-call turns'
  )
  await captureVerificationScreenshot(control, 'plugins-04-skill-and-mcp-complete.png')
}

async function waitForMarketplaceInstallStateAfterUninstall(control, pluginId) {
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The plugin remained installed after the uninstall request'
  )
  // Uninstalling bumps the marketplace refresh tick, which temporarily replaces
  // the catalog rows with a loading state, so poll until the install action
  // settles back instead of asserting against the transient refresh UI.
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  const startedAt = Date.now()
  let lastActionText = ''
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    lastActionText = await control.command('getText', installSelector)
    if (/Install|安装/.test(lastActionText)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(
    `The marketplace did not return to the install state after uninstall; last install action text: ${JSON.stringify(lastActionText)}`
  )
}

async function verifyMarketplacePluginLifecycle({
  control,
  executorHome,
  marketplacePath,
  workspacePath,
}) {
  let bootstrap = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  if (!bootstrap.workbench?.currentProject?.id) {
    await control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await createSingleRootLocalProject(control, workspacePath, 'marketplace-plugin')
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    bootstrap = await waitForWorkbenchDebugState(
      control,
      snapshot => Boolean(snapshot.workbench?.currentProject?.id),
      'Creating a local project did not open an active marketplace project'
    )
  }

  const activeTaskBeforePluginTrial = bootstrap
  let activeTaskId = activeTaskBeforePluginTrial.workbench.currentRuntimeTask?.taskId ?? null
  const activeProjectId = activeTaskBeforePluginTrial.workbench.currentProject?.id
  assert.ok(activeProjectId, 'The marketplace plugin lifecycle requires an active project')

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })

  await control.command('click', '[data-testid="plugins-create-button"]')
  await control.command('click', '[data-testid="plugins-create-plugin-option"]')
  await control.command('waitFor', '[data-testid="plugin-create-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugin-create-workspace') &&
      snapshot.testIds.includes('project-chat-composer') &&
      snapshot.testIds.includes('composer-toolbar') &&
      snapshot.testIds.includes('attachment-file-input') &&
      snapshot.testIds.includes('model-selector-button') &&
      snapshot.testIds.includes('plugin-create-prompt-input') &&
      snapshot.testIds.includes('plugin-create-submit-button') &&
      snapshot.text.includes('Plugin Creator'),
    'The managed Plugin Creator workspace did not open'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-00-creator.png')
  await control.command('fill', '[data-testid="plugin-create-prompt-input"]', {
    value: PLUGIN_CREATOR_PROMPT,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-create-submit-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const pluginCreatorTask = await waitForWorkbenchDebugState(
    control,
    snapshot => {
      const taskId = snapshot.workbench?.currentRuntimeTask?.taskId
      return Boolean(taskId && taskId !== activeTaskId)
    },
    'Creating a plugin continued the existing conversation instead of opening a new task'
  )
  activeTaskId = pluginCreatorTask.workbench.currentRuntimeTask.taskId
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    text: PLUGIN_CREATOR_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="plugins-search-input"]', { value: '' })
  await control.command('click', '[data-testid="plugins-create-button"]')
  await control.command('click', '[data-testid="plugins-add-market-option"]')
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const pluginId = `${PLUGIN_MARKETPLACE_NAME}:${PLUGIN_NAME}@${PLUGIN_MARKETPLACE_NAME}`
  const rowSelector = `[data-testid="plugin-marketplace-row-${pluginId}"]`
  await control.command('waitFor', rowSelector, {
    text: PLUGIN_DISPLAY_NAME,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  const actionsSelector = `[data-testid="plugin-marketplace-actions-${pluginId}"]`
  await captureVerificationScreenshot(control, 'marketplace-plugins-01-marketplace.png')

  await control.command('click', rowSelector)
  await control.command('waitFor', '[data-testid="plugin-detail-get-started"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="plugin-prompt-0"]')
  const useCaseGuideSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugin-use-case-guide') &&
      snapshot.testIds.includes('plugin-use-case-confirmation') &&
      snapshot.testIds.includes('plugin-use-case-goal-input') &&
      snapshot.testIds.includes('plugin-use-case-context-toggle') &&
      snapshot.testIds.includes('plugin-use-case-draft-input') &&
      snapshot.testIds.includes('plugin-use-case-start-button') &&
      snapshot.text.includes('Verify the Wework desktop plugin lifecycle.'),
    'The plugin use-case guide dialog did not show the editable task-draft flow'
  )
  assert.match(
    useCaseGuideSnapshot.text,
    /AI plugin usage guide|AI 插件使用向导/,
    'The plugin use-case guide was not clearly identified as guidance'
  )
  await control.command('click', '[data-testid="plugin-use-case-context-suggestion"]')
  await control.command('click', '[data-testid="plugin-use-case-option-complete-steps"]')
  await control.command('click', '[data-testid="plugin-use-case-context-toggle"]')
  await control.command('fill', '[data-testid="plugin-use-case-context-input"]', {
    value: 'Only inspect changed files.',
  })
  await waitForSnapshot(
    control,
    snapshot =>
      /Complete reversible actions and confirm before submitting or deleting|自动完成场景中的可逆操作，遇到提交或删除时先确认/.test(
        snapshot.text
      ) &&
      /recent conversation|当前对话/.test(snapshot.text) &&
      snapshot.text.includes('Only inspect changed files.'),
    'The plugin task preview did not react to the selected preference and added context'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-02-use-case-guide.png')
  await control.command('press', 'body', { key: 'Escape' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('plugin-use-case-guide'),
    'Escape did not close the plugin use-case guide dialog'
  )
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  await control.command('waitFor', installSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', installSelector)
  await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-connector-auth-dialog"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="local-connector-auth-browser"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const installedSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`) ||
      snapshot.testIds.some(
        testId => testId.startsWith('plugins-installed-strip-item-') && testId.includes(PLUGIN_NAME)
      ),
    'The plugin was not shown as installed after the real app-server request'
  )
  if (!installedSnapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`)) {
    // Install succeeded but the active market/distribution filter hid the card.
    if (installedSnapshot.testIds.includes('plugins-clear-marketplace-filters')) {
      await control.command('click', '[data-testid="plugins-clear-marketplace-filters"]')
    }
    await control.command(
      'click',
      `[data-testid="plugins-marketplace-tab-${PLUGIN_MARKETPLACE_NAME}"]`
    )
    await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
      'The installed plugin card did not reappear under its marketplace tab'
    )
  }
  await control.command('click', actionsSelector)
  const trySelector = `[data-testid="plugin-marketplace-try-${pluginId}"]`
  await control.command('waitFor', trySelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', trySelector),
    /Start chat|立即对话/,
    'The installed plugin did not expose its chat action'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-03-installed.png')

  await control.command('click', actionsSelector)
  await control.command('click', rowSelector)
  const detailActionSelector = '[data-testid^="plugin-detail-toggle-"]'
  await control.command('waitFor', detailActionSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', detailActionSelector),
    /Start chat|立即对话/,
    'The plugin detail did not expose its new-chat action'
  )
  await control.command('click', detailActionSelector)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(PLUGIN_DISPLAY_NAME),
    'Trying the installed plugin did not place its reference in the composer',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask === null &&
      snapshot.workbench?.currentProject?.id === activeProjectId,
    'Starting a plugin chat did not open a new conversation under the active project'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugin-trial-template-strip') &&
      snapshot.testIds.includes('plugin-trial-ai-refine') &&
      snapshot.text.includes(PLUGIN_DISPLAY_NAME),
    'Trying the installed plugin did not expose its AI usage guide'
  )
  await control.command('click', '[data-testid="plugin-trial-ai-refine"]')
  await control.command('waitFor', '[data-testid="plugin-trial-ai-result"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const refinedPluginSuggestion = await control.command(
    'getText',
    '[data-testid="plugin-trial-recommendation-title"]'
  )
  assert.ok(refinedPluginSuggestion.trim(), 'AI did not return a plugin task suggestion')
  await control.command('click', '[data-testid="plugin-trial-recommendation-apply"]')
  await waitForControlValueIncludes(
    control,
    ACTIVE_COMPOSER_SELECTOR,
    refinedPluginSuggestion,
    'The AI-refined plugin task was not applied to the composer'
  )
  await captureVerificationScreenshot(control, 'marketplace-plugins-04-used-in-chat.png')

  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('plugin-trial-template-strip'),
    'Dismissing the plugin trial guide did not close the recommendation strip'
  )
  const composerPluginItemTestId = await waitForInstalledComposerPlugin(control, {
    pluginName: PLUGIN_NAME,
    pluginDisplayName: PLUGIN_DISPLAY_NAME,
  })
  const composerPluginSelector = `[data-testid="${composerPluginItemTestId}"]`
  await control.command('click', composerPluginSelector)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes('plugin-trial-template-strip'),
    'Selecting the installed plugin from the composer did not expose its templates'
  )

  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '/desktop' })
  const slashPluginSelector = `[data-testid="slash-command-option-app-plugin-${PLUGIN_NAME}"]`
  await control.command('waitFor', slashPluginSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', slashPluginSelector)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes('plugin-trial-template-strip'),
    'Selecting the installed plugin from slash commands did not expose its templates'
  )

  await control.command('click', '[data-testid="plugin-trial-template-dismiss"]')
  await rm(join(executorHome, CONNECTOR_AUTH_MARKER_NAME), { force: true })
  control.scenarioRequests.delete('connector_auth_unmatched_resume')
  control.setScenario('connector_auth_unmatched_resume')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
    value: CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  })
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
  const unmatchedResumeSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !unmatchedResumeSnapshot.testIds.includes('connector-auth-card'),
    'Unmatched connector auth resume incorrectly showed the chat auth card'
  )
  assert.ok(
    !unmatchedResumeSnapshot.testIds.includes('local-connector-auth-dialog'),
    'Unmatched connector auth resume incorrectly showed the install auth dialog'
  )
  await captureVerificationScreenshot(
    control,
    'marketplace-plugins-05b-unmatched-resume-no-auth-card.png'
  )

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-search-input"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command(
    'click',
    `[data-testid="plugins-marketplace-tab-${PLUGIN_MARKETPLACE_NAME}"]`
  )
  await control.command('waitFor', actionsSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const uninstallSelector = `[data-testid="plugin-marketplace-uninstall-${pluginId}"]`
  await control.command('click', actionsSelector)
  await control.command('waitFor', uninstallSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', uninstallSelector)
  await control.command('waitFor', '[data-testid="plugin-uninstall-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-uninstall-confirm-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForMarketplaceInstallStateAfterUninstall(control, pluginId)
  await captureVerificationScreenshot(control, 'marketplace-plugins-05-uninstalled.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="composer-plugin-picker-button"]')
  await control.command('waitFor', '[data-testid="composer-plugin-picker"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const composerAfterUninstall = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !composerAfterUninstall.testIds.includes(`composer-plugin-picker-item-plugin:${PLUGIN_NAME}`),
    'The uninstalled marketplace plugin remained available in the composer plugin picker'
  )
  await captureVerificationScreenshot(
    control,
    'marketplace-plugins-06-composer-after-uninstall.png'
  )
}

async function verifySkillMentionRendering({ control, fixture }) {
  const officialPluginTaskId = await createOfficialPluginTask({
    control,
    installSelector: fixture.installSelector,
    skillPath: fixture.skillPath,
  })
  const qualifiedSkillName = `${OFFICIAL_PLUGIN_NAME}:${OFFICIAL_PLUGIN_SKILL_NAME}`
  const qualifiedSkillTestId = qualifiedSkillName.replace(/[^a-zA-Z0-9_-]/g, '-')
  await control.command('click', '[data-testid="new-chat-button"]')
  control.setScenario('skill_mention_display')
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
    value: `[$${qualifiedSkillName}](${fixture.skillPath}) ${QUALIFIED_SKILL_MENTION_PROMPT}`,
  })
  await control.command('waitFor', `[data-testid="local-skill-chip-${qualifiedSkillTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const qualifiedSkillTaskId = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  ).workbench?.currentRuntimeTask?.taskId
  assert.ok(qualifiedSkillTaskId, 'The qualified skill conversation did not expose its task ID')
  const officialPluginTaskRow = `[data-testid="runtime-local-task-row-${officialPluginTaskId}"]`
  const qualifiedSkillTaskRow = `[data-testid="runtime-local-task-row-${qualifiedSkillTaskId}"]`
  await control.command('waitFor', officialPluginTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', qualifiedSkillTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', officialPluginTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: OFFICIAL_PLUGIN_SKILL_READY_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await assertMentionRenderedAsToken(control, {
    tokenSelector: '[data-testid="sent-plugin-token-OpenAI-Developers"]',
    tokenText: OFFICIAL_PLUGIN_DISPLAY_NAME,
    plainTextMention: `@${OFFICIAL_PLUGIN_NAME}`,
    errorLabel: 'The reopened plugin reference degraded to its plain-text mention',
  })
  await control.command('clickWhenEnabled', qualifiedSkillTaskRow, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await assertMentionRenderedAsToken(control, {
    tokenSelector: `[data-testid="sent-local-skill-token-${qualifiedSkillTestId}"]`,
    plainTextMention: `$${qualifiedSkillName}`,
    errorLabel: 'The reloaded qualified skill reference degraded to its plain-text mention',
  })
  await captureVerificationScreenshot(control, 'skill-mention-01-reloaded.png')
}

async function uninstallOfficialPlugin(control, fixture) {
  await control.command('click', '[data-testid="plugins-button"]')
  const pluginsSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (pluginsSnapshot.testIds.includes('plugin-detail-back-button')) {
    await control.command('click', '[data-testid="plugin-detail-back-button"]')
  }
  await openMarketplacePluginActions(control, {
    pluginId: fixture.pluginId,
    marketplaceName: OFFICIAL_PLUGIN_MARKETPLACE_NAME,
    displayName: OFFICIAL_PLUGIN_DISPLAY_NAME,
  })
  const uninstallSelector = `[data-testid="plugin-marketplace-uninstall-${fixture.pluginId}"]`
  await control.command('waitFor', uninstallSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', uninstallSelector)
  await control.command('waitFor', '[data-testid="plugin-uninstall-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugin-uninstall-confirm-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForMarketplaceInstallStateAfterUninstall(control, fixture.pluginId)
  await captureVerificationScreenshot(control, 'plugins-05-uninstalled.png')
}

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
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (!initialSnapshot.testIds.includes('automation-button')) {
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('waitFor', '[data-testid="general-experimental-features-toggle"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="general-experimental-features-toggle"]')
    await control.command('click', '[data-testid="settings-back-button"]')
    await control.command('waitFor', '[data-testid="automation-button"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
  return initialSnapshot
}

async function verifyAutomationLifecycle(control, workspacePath) {
  const initialSnapshot = await ensureExperimentalFeaturesEnabled(control)
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

  const previousScenario = control.scenario
  control.setScenario('automation')
  try {
    await control.command('click', `[data-testid="${automationActions}"]`)
    await control.command('click', '[data-testid="automation-run-now-button"]')
    await control.awaitScenarioRequestCount('automation', 1, WORKBENCH_READY_TIMEOUT_MS)

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
    if (!manualTaskSnapshot.text.includes(`${AUTOMATION_COMPLETION_TEXT}_1`)) {
      await control.command('click', `[data-testid="${manualTaskRow}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: `${AUTOMATION_COMPLETION_TEXT}_1`,
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
    }
    await control.command('click', `[data-testid="runtime-local-task-mark-${manualTaskId}"]`)
    await waitForSnapshot(
      control,
      snapshot => snapshot.testIds.includes('sidebar-pinned-section'),
      'The automation task was not pinned before testing existing-task mode'
    )

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
    await control.command('click', '[data-testid="automation-target-task-select"]')
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
    await control.awaitScenarioRequestCount('automation', 2, AUTOMATION_SCHEDULE_TIMEOUT_MS)
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
    await captureVerificationScreenshot(control, 'automations-02-scheduled-complete.png')
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
    await captureVerificationScreenshot(control, 'automations-01-local-persisted.png')
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

function processIsAlive(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function macosSleepInhibitorProcessIds(appProcessId) {
  if (process.platform !== 'darwin') return []
  const output = commandOutput('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match || Number(match[2]) !== appProcessId || match[3] !== '/usr/bin/caffeinate -i') {
      return []
    }
    return [Number(match[1])]
  })
}

async function waitForMacosSleepInhibitor(appProcessId, expectedRunning) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const processIds = macosSleepInhibitorProcessIds(appProcessId)
    if (processIds.length > 0 === expectedRunning) return processIds
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(
    `Timed out waiting for the macOS sleep inhibitor to be ${expectedRunning ? 'running' : 'stopped'}`
  )
}

async function waitForExecutorReadyEvidence(
  logPath,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  minimumProcessCount = 1
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(logPath, 'utf8').catch(() => '')
    const processIds = [...content.matchAll(/app IPC stdio ready[^\n]*process_id=(\d+)/g)].map(
      match => Number(match[1])
    )
    if (processIds.length >= minimumProcessCount) return { processIds, content }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for executor stdio-ready evidence in ${logPath}`)
}

async function waitForLogPattern(
  logPath,
  pattern,
  { fromOffset = 0, timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(logPath, 'utf8').catch(() => '')
    if (pattern.test(content.slice(fromOffset))) return content
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for ${pattern} in ${logPath} after offset ${fromOffset}`)
}

async function reactivateMacApplication(appIdentifier) {
  await runChecked('open', ['-g', '-b', appIdentifier])
}

async function triggerModelReloadUntilCloudFailure(control) {
  const failedCloudModelRequest = control.awaitFailedCloudModelRequest()
  for (let attempt = 0; attempt < 10 && control.failedCloudModelRequests === 0; attempt += 1) {
    await control.command('dispatchLocalModelSettingsChanged', '')
    await Promise.race([
      failedCloudModelRequest,
      new Promise(resolvePromise => setTimeout(resolvePromise, 1_000)),
    ])
  }
  await withTimeout(
    failedCloudModelRequest,
    DEFAULT_STEP_TIMEOUT_MS,
    'The connected desktop app did not retry models after the cloud endpoint began failing'
  )
}

async function sendPromptUntilScenarioRequest(control, selector, prompt, scenario) {
  const scenarioRequest = control.awaitScenarioRequest(scenario)
  await sendPrompt(control, selector, prompt)
  return withTimeout(
    scenarioRequest,
    DEFAULT_STEP_TIMEOUT_MS,
    `The model service did not receive the ${scenario} request`
  )
}

async function revealGroupedModelOption(control, targetOptionId) {
  const menu = JSON.parse(await control.command('snapshot', 'body'))
  if (menu.testIds.includes(targetOptionId)) return true
  const familyTestIds = menu.testIds.filter(testId => testId.startsWith('model-family-'))

  for (const familyTestId of familyTestIds) {
    await control.command('hover', `[data-testid="${familyTestId}"]`, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
    const familyMenu = JSON.parse(await control.command('snapshot', 'body'))
    if (familyMenu.testIds.includes(targetOptionId)) return true
  }

  return false
}

async function ensureModelOptionVisible(control, targetOptionId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let menu = JSON.parse(await control.command('snapshot', 'body'))
    if (menu.testIds.includes(targetOptionId)) return menu
    if (menu.testIds.includes('model-control-menu-model')) {
      await control
        .command('hover', '[data-testid="model-control-menu-model"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        .catch(() => undefined)
    } else {
      await control
        .command('hover', '[data-testid="model-selector-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        .catch(() => undefined)
      menu = JSON.parse(await control.command('snapshot', 'body'))
      if (!menu.testIds.includes('model-selector-menu')) {
        await control.command('clickWhenEnabled', '[data-testid="model-selector-button"]', {
          stableMs: 100,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
    menu = JSON.parse(await control.command('snapshot', 'body'))
    if (menu.testIds.includes(targetOptionId)) return menu
    if (await revealGroupedModelOption(control, targetOptionId)) {
      return JSON.parse(await control.command('snapshot', 'body'))
    }
  }

  throw new Error(`Model option ${targetOptionId} did not become visible`)
}

async function confirmLocalProjectName(control, name) {
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: name,
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('local-project-create-dialog'),
    'The local project create dialog did not close after confirmation'
  )
}

async function createSingleRootLocalProject(control, workspacePath, name) {
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-local-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await confirmLocalProjectName(control, name)
}

async function selectE2EModel(
  control,
  modelId = DEFAULT_MODEL_ID,
  modelLabel = DEFAULT_MODEL_LABEL
) {
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const selectedModelLabel = await control.command(
    'getText',
    '[data-testid="model-selector-button"]'
  )
  if (selectedModelLabel.includes(modelLabel)) return

  const targetOptionId = `model-option-${modelId}`
  await ensureModelOptionVisible(control, targetOptionId)
  await control.command('waitFor', `[data-testid="model-option-${modelId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="model-option-${modelId}"]`)
  const selectionSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  if (selectionSnapshot.testIds.includes('model-switch-warning-dialog')) {
    await control.command(
      'clickWhenEnabled',
      '[data-testid="model-switch-warning-confirm-button"]',
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
  }
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    text: modelLabel,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('press', 'body', { key: 'Escape' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('model-selector-menu'),
    'The model selector menu did not close after selecting the E2E model'
  )
}

async function verifyCrossProviderSwitchRetry(control, composerSelector) {
  control.setScenario('provider_switch_retry')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, PROVIDER_SWITCH_LUNA_OPTION_ID, PROVIDER_SWITCH_LUNA_LABEL)
  await sendPrompt(control, composerSelector, PROVIDER_SWITCH_PROMPT)
  await control.command('waitFor', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    1,
    'The failed Luna turn was unexpectedly sent more than once'
  )

  await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
  await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="model-selector-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await ensureModelOptionVisible(control, `model-option-${PROVIDER_SWITCH_OFFICIAL_OPTION_ID}`)
  const officialModelSelector = `[data-testid="model-option-${PROVIDER_SWITCH_OFFICIAL_OPTION_ID}"]`
  await control.command('waitFor', officialModelSelector, {
    text: PROVIDER_SWITCH_OFFICIAL_LABEL,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', officialModelSelector)
  await control.command('waitFor', '[data-testid="model-switch-warning-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="model-switch-warning-confirm-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PROVIDER_SWITCH_COMPLETION,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    control.scenarioRequests.get('provider_switch_retry')?.length,
    2,
    'The cross-provider retry did not make one Luna request and one official GPT request'
  )
  await control.command('waitFor', '[data-testid="model-selector-button"]', {
    text: PROVIDER_SWITCH_OFFICIAL_LABEL,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyBackgroundTaskWindowLifecycle({
  app,
  appIdentifier,
  composerSelector,
  control,
  executorLogPath,
  restartDesktopApp,
  setPhase,
}) {
  const lifecycleScreenshotName = name => `window-lifecycle-${name}`
  setPhase('popout-window-lifecycle')
  await verifyPopoutWindowLifecycle(control, composerSelector)
  setPhase('close-request-without-running-task')
  await control.command('requestMainWindowClose', 'body')
  await control.command('waitFor', '[data-testid="runtime-task-close-confirm-overlay"]', {
    visible: true,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="runtime-task-close-cancel-button"]')
  const closeCancelledSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  assert.ok(
    !closeCancelledSnapshot.testIds.includes('runtime-task-close-confirm-overlay'),
    'The close-to-tray prompt remained open after cancelling'
  )
  setPhase('background-streaming-task')
  control.setScenario('window_lifecycle')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    WINDOW_LIFECYCLE_PROMPT,
    'window_lifecycle'
  )
  await withTimeout(
    control.awaitWindowLifecycleResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'Timed out waiting for the streaming response to start'
  )
  const sleepInhibitorEvidence = []
  if (process.platform === 'darwin') {
    const processIds = await waitForMacosSleepInhibitor(app.pid, true)
    sleepInhibitorEvidence.push({ stage: 'task-running', processIds })
  }
  const runningTaskSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-running-')),
    'The running task was not available before closing the window'
  )
  const runningTaskTestId = runningTaskSnapshot.testIds.find(testId =>
    testId.startsWith('runtime-local-task-running-')
  )
  assert.ok(runningTaskTestId, 'The running task indicator was not found')
  const taskRowTestId = runningTaskTestId.replace(
    'runtime-local-task-running-',
    'runtime-local-task-row-'
  )

  await getSingleElementMetrics(control, ACTIVE_WORKBENCH_SELECTOR, 'The running conversation pane')
  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)

  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('01-task-running-in-background-before-window-close.png')
  )

  if (process.platform === 'darwin') {
    setPhase('close-to-tray-and-reopen')
    const readyCountBeforeClose = control.readyCount
    const controlClientIdBeforeClose = control.ready?.clientId
    assert.ok(
      controlClientIdBeforeClose,
      'The original WebView did not register a control client ID'
    )
    const readyEvidenceBeforeClose = await waitForExecutorReadyEvidence(executorLogPath)
    const executorProcessId = readyEvidenceBeforeClose.processIds.at(-1)
    assert.ok(executorProcessId, 'The executor stdio-ready log did not include a process ID')
    assert.equal(processIsAlive(app.pid), true, 'The Wework process was not alive before close')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The executor process was not alive before close'
    )

    await control.command('requestMainWindowClose', 'body')
    await control.command('waitFor', '[data-testid="runtime-task-close-confirm-overlay"]', {
      visible: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('click', '[data-testid="runtime-task-close-confirm-button"]')
    await waitForLogPattern(join(resultDir, `wework-tauri-${app.pid}.log`), /windowWillClose:/)
    assert.equal(processIsAlive(app.pid), true, 'Closing to tray terminated the Wework process')
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'Closing to tray terminated the executor process'
    )
    const backgroundProcessIds = await waitForMacosSleepInhibitor(app.pid, true)
    sleepInhibitorEvidence.push({
      stage: 'window-closed-to-tray',
      processIds: backgroundProcessIds,
    })

    await reactivateMacApplication(appIdentifier)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened Wework WebView did not reconnect to the desktop controller'
    )
    assert.notEqual(
      control.ready?.clientId,
      controlClientIdBeforeClose,
      'The reopened WebView reused the closed control client identity'
    )
    const reopenedTaskWait = control.command('waitFor', `[data-testid="${taskRowTestId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const staleClientPoll = await fetch(
      `${control.controlUrl}/commands?clientId=${encodeURIComponent(controlClientIdBeforeClose)}`
    )
    assert.equal(
      staleClientPoll.status,
      204,
      'A closed WebView control client was able to steal a replacement WebView command'
    )
    await reopenedTaskWait
    const readyEvidenceAfterReopen = await waitForExecutorReadyEvidence(executorLogPath)
    assert.deepEqual(
      readyEvidenceAfterReopen.processIds,
      [executorProcessId],
      'Reopening the window spawned or attached to a different executor process'
    )
    assert.equal(
      processIsAlive(executorProcessId),
      true,
      'The original executor process was not alive after reopening the window'
    )
    await writeFile(
      join(resultDir, 'stdio-lifecycle-verification.json'),
      `${JSON.stringify(
        {
          appProcessId: app.pid,
          executorProcessId,
          executorReadyLogCount: readyEvidenceAfterReopen.processIds.length,
          webviewReadyCountBeforeClose: readyCountBeforeClose,
          webviewReadyCountAfterReopen: control.readyCount,
          appAliveAfterReopen: processIsAlive(app.pid),
          executorAliveAfterReopen: processIsAlive(executorProcessId),
        },
        null,
        2
      )}\n`
    )
    await captureVerificationScreenshot(
      control,
      lifecycleScreenshotName('02-window-reopened-task-still-running.png')
    )
  }

  await waitForBlankConversation(control, composerSelector)
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('03-background-task-after-reopen.png')
  )
  control.releaseWindowLifecycleResponse()
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(runningTaskTestId),
    'The background task did not settle while another pane was active'
  )
  const unreadTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-unread-dot-'
  )
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(unreadTaskTestId),
    'The settled background task did not become unread'
  )
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('message-assistant') &&
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT) &&
      !snapshot.testIds.includes(unreadTaskTestId) &&
      !snapshot.testIds.includes('thinking-indicator'),
    'Switching to the completed background task did not show its latest read state',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  const initiallyOpenedMetrics = await waitForBottomMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The initially opened completed conversation scroll container'
  )
  assert.ok(
    distanceFromBottom(initiallyOpenedMetrics) <= 2,
    'A previously unopened completed conversation did not open at the bottom'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('04-background-task-latest-state-after-switch.png')
  )
  if (process.platform === 'darwin') {
    const processIds = await waitForMacosSleepInhibitor(app.pid, false)
    sleepInhibitorEvidence.push({ stage: 'task-completed', processIds })
    await writeFile(
      join(resultDir, 'sleep-inhibitor-lifecycle-verification.json'),
      `${JSON.stringify({ appProcessId: app.pid, stages: sleepInhibitorEvidence }, null, 2)}\n`
    )
  }

  setPhase('completed-task-reopen')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(WINDOW_LIFECYCLE_COMPLETION_TEXT) &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes(runningTaskTestId) &&
      snapshot.testIds.includes('send-message-button'),
    'The completed task became busy again after reopening its continuable conversation',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('05-completed-task-reopened-idle.png')
  )

  const reopenedBottomMetrics = await waitForBottomMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The reopened bottom-pinned conversation scroll container'
  )
  assert.ok(
    distanceFromBottom(reopenedBottomMetrics) <= 2,
    'A conversation that was previously at the bottom did not reopen at the bottom'
  )

  setPhase('completed-task-scroll-position')
  const middleParagraphSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-scroll-anchor]:nth-of-type(14)`
  await control.command('scrollIntoViewAsUser', middleParagraphSelector)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  const middlePositionBeforeSwitch = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The middle-position conversation scroll container before switching'
  )
  const middleDistanceBeforeSwitch = distanceFromBottom(middlePositionBeforeSwitch)
  assert.ok(
    middlePositionBeforeSwitch.scrollTop > 100,
    'The long conversation did not leave the top before testing position restoration'
  )
  assert.ok(
    middleDistanceBeforeSwitch > 100,
    'The long conversation did not leave the bottom before testing position restoration'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('06-task-middle-position-before-switch.png')
  )

  control.setScenario('fresh_chat')
  const taskRowsBeforeFreshChat = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await sendPrompt(control, composerSelector, FRESH_CHAT_PROMPT)
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: FRESH_CHAT_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const freshTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeFreshChat,
    'WEWORK_DESKTOP_E2E_FRESH_CHAT'
  )
  const shortConversationMetrics = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The short conversation scroll container'
  )
  assert.ok(
    shortConversationMetrics.scrollHeight <= shortConversationMetrics.clientHeight + 1,
    `The short conversation overflowed by ${shortConversationMetrics.scrollHeight - shortConversationMetrics.clientHeight}px`
  )
  await getSingleElementMetrics(
    control,
    ACTIVE_WORKBENCH_SELECTOR,
    'The switched conversation pane'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('07-switched-to-new-task.png')
  )

  await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', middleParagraphSelector, {
    text: WINDOW_LIFECYCLE_SCROLL_MARKER,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  const middlePositionAfterSwitch = await getSingleElementMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The middle-position conversation scroll container after switching back'
  )
  const middleDistanceAfterSwitch = distanceFromBottom(middlePositionAfterSwitch)
  assert.ok(
    middlePositionAfterSwitch.scrollTop > 100,
    'The restored long conversation unexpectedly returned to the top'
  )
  assert.ok(
    middleDistanceAfterSwitch > 100,
    'The restored long conversation unexpectedly returned to the bottom'
  )
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('08-task-middle-position-after-switch-back.png')
  )
  assert.ok(
    Math.abs(middlePositionAfterSwitch.scrollTop - middlePositionBeforeSwitch.scrollTop) <= 32,
    `The middle scroll position moved from ${middlePositionBeforeSwitch.scrollTop}px to ${middlePositionAfterSwitch.scrollTop}px`
  )

  setPhase('turn-navigation-virtualized-anchor')
  control.setScenario('turn_navigation')
  for (let index = 0; index < TURN_NAVIGATION_REGRESSION_TURN_COUNT; index += 1) {
    const turnNumber = index + 1
    const completionText = `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`
    await sendPrompt(
      control,
      composerSelector,
      `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      { text: completionText, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
  }

  await control.command('waitFor', '[data-testid="message-turn-navigation-marker"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="message-turn-navigation-marker"]')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  const navigationTopMetrics = await waitForTopMetrics(
    control,
    '[data-testid="desktop-workbench-content"]',
    'The conversation after jumping to the first virtualized turn'
  )
  assert.ok(
    navigationTopMetrics.scrollHeight > navigationTopMetrics.clientHeight * 4,
    'The turn navigation regression conversation was not long enough to exercise virtualization'
  )
  await control.command('waitFor', `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`, {
    text: WINDOW_LIFECYCLE_PROMPT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(
    control,
    lifecycleScreenshotName('09-first-virtualized-turn-navigation-target.png')
  )
  setPhase('archived-task-cache-eviction')
  const cacheBeforeArchive = JSON.parse(
    await control.command('performanceSnapshot', 'body')
  ).runtimeConversationCache
  const freshTaskId = freshTaskRowTestId.replace('runtime-local-task-row-', '')
  await control.command('click', `[data-testid="runtime-local-task-archive-${freshTaskId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="runtime-local-task-archive-toast-${freshTaskId}"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const archivedTaskSelector = `[data-testid="${freshTaskRowTestId}"]`
  const archiveRowRemovalStartedAt = Date.now()
  let archivedTaskRowCount = 1
  while (Date.now() - archiveRowRemovalStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
    archivedTaskRowCount = Number(await control.command('getElementCount', archivedTaskSelector))
    if (archivedTaskRowCount === 0) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.equal(archivedTaskRowCount, 0, 'The archived task remained mounted in the sidebar')
  const archiveEvictionStartedAt = Date.now()
  let cacheAfterArchive = cacheBeforeArchive
  while (Date.now() - archiveEvictionStartedAt < DEFAULT_STEP_TIMEOUT_MS) {
    cacheAfterArchive = JSON.parse(
      await control.command('performanceSnapshot', 'body')
    ).runtimeConversationCache
    if (cacheAfterArchive.messageEntries < cacheBeforeArchive.messageEntries) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.ok(
    cacheAfterArchive.messageEntries < cacheBeforeArchive.messageEntries,
    `Archiving retained conversation messages (${cacheBeforeArchive.messageEntries} -> ${cacheAfterArchive.messageEntries})`
  )
  assert.ok(
    cacheAfterArchive.scrollSnapshotEntries <= cacheBeforeArchive.scrollSnapshotEntries &&
      cacheAfterArchive.virtualMeasurementEntries <= cacheBeforeArchive.virtualMeasurementEntries,
    'Archiving increased retained conversation view state'
  )
  await writeFile(
    join(resultDir, 'conversation-switching-cache-eviction.json'),
    `${JSON.stringify({ before: cacheBeforeArchive, after: cacheAfterArchive }, null, 2)}\n`,
    'utf8'
  )
  await reopenCurrentTurnNavigationTask(control, composerSelector, restartDesktopApp)
  await verifyVirtualizedTurnNavigationActiveMarker(control)
  return taskRowTestId
}

async function verifyPopoutWindowLifecycle(control, composerSelector) {
  await control.command('showPopoutWindow', 'body')
  try {
    if (process.platform === 'darwin') {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
      const dataUrl = await control.command('capturePopoutWindow', 'body', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const prefix = 'data:image/png;base64,'
      assert.ok(dataUrl.startsWith(prefix), 'Popout Window capture did not return PNG data')
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      assert.ok(png.length > 10_000, 'Popout Window capture did not contain rendered controls')
      await writeFile(join(resultDir, 'window-lifecycle-00-popout-window.png'), png)
    }
  } finally {
    await control.command('dismissPopoutWindow', 'body')
  }
  const reopenStartedAt = Date.now()
  await control.command('showPopoutWindow', 'body')
  const reopenDurationMs = Date.now() - reopenStartedAt
  try {
    assert.ok(
      reopenDurationMs < 2_000,
      `Warm Popout Window reopen took ${reopenDurationMs}ms instead of reusing the hidden WebView`
    )
    if (process.platform === 'darwin') {
      const dataUrl = await control.command('capturePopoutWindow', 'body', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const prefix = 'data:image/png;base64,'
      assert.ok(
        dataUrl.startsWith(prefix),
        'Reopened Popout Window capture did not return PNG data'
      )
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      assert.ok(png.length > 10_000, 'Reopened Popout Window was not immediately rendered')
      await writeFile(join(resultDir, 'window-lifecycle-01-popout-window-reopened.png'), png)
    }
  } finally {
    await control.command('dismissPopoutWindow', 'body')
  }
  await control.command('waitFor', composerSelector, {
    visible: true,
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
}

async function attachAndSendOnlyFile(control, composerSelector) {
  await control.command('dropFile', composerSelector, {
    filename: ATTACHMENT_ONLY_FILENAME,
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
}

async function verifyAttachmentOnlySidebarLifecycle({
  app,
  appIdentifier,
  composerSelector,
  control,
}) {
  control.setScenario('attachment_only')
  const rowsBeforeAttachmentOnly = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )

  await attachAndSendOnlyFile(control, composerSelector)
  await captureVerificationScreenshot(control, '01-attachment-only-first-submitted.png')
  await control.awaitScenarioRequestCount('attachment_only', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const firstSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        testId =>
          testId.startsWith('runtime-local-task-row-') && !rowsBeforeAttachmentOnly.has(testId)
      ),
    'The first attachment-only task did not appear in the sidebar'
  )
  const firstTaskRow = firstSnapshot.testIds.find(
    testId => testId.startsWith('runtime-local-task-row-') && !rowsBeforeAttachmentOnly.has(testId)
  )
  assert.ok(firstTaskRow, 'The first attachment-only task row was not found')
  await captureVerificationScreenshot(control, '02-attachment-only-first-completed.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await attachAndSendOnlyFile(control, composerSelector)
  await captureVerificationScreenshot(control, '03-attachment-only-second-submitted.png')
  await control.awaitScenarioRequestCount('attachment_only', 2)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })

  const twoTaskSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(firstTaskRow) &&
      snapshot.testIds.some(
        testId =>
          testId.startsWith('runtime-local-task-row-') &&
          testId !== firstTaskRow &&
          !rowsBeforeAttachmentOnly.has(testId)
      ),
    'A same-title attachment-only task disappeared after the authoritative sidebar refresh'
  )
  const secondTaskRow = twoTaskSnapshot.testIds.find(
    testId =>
      testId.startsWith('runtime-local-task-row-') &&
      testId !== firstTaskRow &&
      !rowsBeforeAttachmentOnly.has(testId)
  )
  assert.ok(secondTaskRow, 'The second attachment-only task row was not found')
  const expectedRows = [firstTaskRow, secondTaskRow]
  await captureVerificationScreenshot(control, '04-attachment-only-two-tasks-after-refresh.png')

  if (process.platform === 'darwin') {
    const readyCountBeforeClose = control.readyCount
    const tauriLogPath = join(resultDir, `wework-tauri-${app.pid}.log`)
    const tauriLogLengthBeforeClose = (await readFile(tauriLogPath, 'utf8').catch(() => '')).length
    await control.command('closeMainWindowToTray', 'body')
    await waitForLogPattern(tauriLogPath, /windowWillClose:/, {
      fromOffset: tauriLogLengthBeforeClose,
    })
    await reactivateMacApplication(appIdentifier)
    await withTimeout(
      control.awaitReadyAfter(readyCountBeforeClose),
      WORKBENCH_READY_TIMEOUT_MS,
      'The reopened Wework WebView did not reconnect during attachment-only verification'
    )
  } else {
    await control.command('navigate', '/')
  }

  for (const testId of expectedRows) {
    await control.command('waitFor', `[data-testid="${testId}"]`, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  await control.command('clickWhenEnabled', `[data-testid="${secondTaskRow}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_2`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(control, '05-attachment-only-current-image-after-reopen.png')

  await control.command('clickWhenEnabled', `[data-testid="${firstTaskRow}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: `${ATTACHMENT_ONLY_COMPLETION_TEXT}_1`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-image-preview"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  await captureVerificationScreenshot(control, '06-attachment-only-first-image-after-reopen.png')

  const requests = control.scenarioRequests.get('attachment_only') ?? []
  assert.equal(requests.length, 2, 'Attachment-only flow did not send exactly two model requests')
  for (const request of requests) {
    const serialized = JSON.stringify(request.body)
    assert.ok(
      serialized.includes(ATTACHMENT_ONLY_FILENAME),
      'The attachment filename was not forwarded to the real Codex request'
    )
  }
}

async function verifyPastedZipAttachment({ composerSelector, control }) {
  control.setScenario('pasted_zip_attachment')
  await control.command('snapshot', 'body')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('pasteFile', composerSelector, {
    filename: PASTED_ZIP_FILENAME,
    mimeType: 'application/zip',
    value: PASTED_ZIP_BASE64,
  })
  await control.command('waitFor', '[data-testid="attachment-badge"]', {
    text: PASTED_ZIP_FILENAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('pasted_zip_attachment', 1)
  await control.command('waitFor', '[data-testid="message-document-attachment"]', {
    text: PASTED_ZIP_FILENAME,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PASTED_ZIP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'pasted-zip-attachment.png')
}

async function verifySystemDragPanelLayout(control) {
  await control.command('navigate', 'body', { value: '/system-drag' })
  await control.command('waitFor', '[data-testid="system-drag-panel"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    visible: true,
  })
  const [metrics] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="system-drag-panel"]')
  )
  assert.deepEqual(
    { height: metrics.height, width: metrics.width },
    { height: 60, width: 440 },
    'The system drag panel did not use the compact desktop dimensions'
  )
  const snapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="system-drag-panel"]')
  )
  assert.match(
    snapshot.text,
    /Create new chat|创建新对话/,
    'The system drag panel did not expose the new-chat destination'
  )
  assert.match(
    snapshot.text,
    /Temporary stash|临时暂存/,
    'The system drag panel did not expose the stash destination'
  )
  await captureVerificationScreenshot(
    control,
    'system-drag-panel.png',
    '[data-testid="system-drag-panel"]'
  )
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="new-chat-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const focusSnapshot = JSON.parse(
    await control.command('completeSystemDragDrop', 'body', {
      value: JSON.stringify({
        action: 'new-chat',
        text: 'System drag Popout Window verification',
        paths: [],
      }),
    })
  )
  try {
    assert.equal(
      focusSnapshot.mainFocused,
      false,
      'Completing a system drag incorrectly focused the main window'
    )
    assert.equal(
      focusSnapshot.popoutExists && focusSnapshot.popoutVisible,
      true,
      'Completing a system drag did not reveal the Popout Window'
    )
    if (process.platform === 'darwin') {
      const dataUrl = await control.command('capturePopoutWindow', 'body', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const prefix = 'data:image/png;base64,'
      assert.ok(dataUrl.startsWith(prefix), 'System drag did not reveal a capturable Popout Window')
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      assert.ok(png.length > 10_000, 'System drag revealed an empty Popout Window')
      await writeFile(join(resultDir, 'system-drag-popout-window.png'), png)
    }
  } finally {
    await control.command('dismissPopoutWindow', 'body')
  }
}

async function verifyPastedWorkspacePaths({ composerSelector, control, workspacePath }) {
  control.setScenario('pasted_workspace_paths')
  const folderPath = join(workspacePath, PASTED_PATH_FOLDER_NAME)
  const filePath = join(workspacePath, PASTED_PATH_FILE_NAME)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'nested path context\n')
  await writeFile(filePath, '# Pasted path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('pastePaths', composerSelector, {
    value: JSON.stringify([
      {
        uri: pathToFileURL(folderPath).href,
        name: PASTED_PATH_FOLDER_NAME,
        isDirectory: true,
      },
      {
        uri: pathToFileURL(filePath).href,
        name: PASTED_PATH_FILE_NAME,
        mimeType: 'text/markdown',
      },
    ]),
  })
  await control.command(
    'waitFor',
    `[data-testid="composer-path-chip-${PASTED_PATH_FOLDER_NAME}"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', '[data-testid="composer-path-chip-pasted-context-md"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes('attachment-badge'),
    false,
    'Pasted local paths were copied into attachment uploads'
  )
  await captureVerificationScreenshot(control, 'pasted-workspace-paths.png')
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('pasted_workspace_paths', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: PASTED_PATH_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath }) {
  control.setScenario('dropped_workspace_paths')
  const folderPath = join(workspacePath, DROPPED_PATH_FOLDER_NAME)
  const filePath = join(workspacePath, DROPPED_PATH_FILE_NAME)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'nested dropped path context\n')
  await writeFile(filePath, '# Dropped path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('dropPaths', composerSelector, {
    value: JSON.stringify([
      {
        uri: pathToFileURL(folderPath).href,
        name: DROPPED_PATH_FOLDER_NAME,
        isDirectory: true,
      },
      {
        uri: pathToFileURL(filePath).href,
        name: DROPPED_PATH_FILE_NAME,
        mimeType: 'text/markdown',
      },
    ]),
  })
  await control.command(
    'waitFor',
    `[data-testid="composer-path-chip-${DROPPED_PATH_FOLDER_NAME}"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('waitFor', '[data-testid="composer-path-chip-dropped-context-md"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    snapshot.testIds.includes('attachment-badge'),
    false,
    'Dropped local paths were copied into attachment uploads'
  )
  await captureVerificationScreenshot(control, 'dropped-workspace-paths.png')
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.awaitScenarioRequestCount('dropped_workspace_paths', 1)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: DROPPED_PATH_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifySideChatAttachmentIsolation({
  control,
  expectedCompletionText = COMPLETION_TEXT,
  taskRowTestId,
}) {
  const sideChatSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-chat-panel"]`
  const rightPanelShellSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
  const mainComposerSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
  const sideComposerSelector = `${sideChatSelector} [data-testid="chat-message-input"]`

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-empty-composer-frame"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(expectedCompletionText),
    'The source conversation did not restore before opening the side chat',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  control.setScenario('side_chat_attachment')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  await control.command('click', '[data-testid="right-workspace-chat-option"]')
  await control.command('waitFor', sideComposerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })

  const workbenchWidth = Number.parseFloat(
    await control.command('getStyle', ACTIVE_WORKBENCH_SELECTOR, { value: 'width' })
  )
  const panelWidthStyle = await control.command('getInlineStyle', rightPanelShellSelector, {
    value: 'width',
  })
  const chatWidthMatch = panelWidthStyle.match(/^calc\(100% - ([\d.]+)px\)$/)
  assert.ok(chatWidthMatch, `Unexpected right-panel width style: ${panelWidthStyle}`)
  const panelWidth = workbenchWidth - Number.parseFloat(chatWidthMatch[1])
  assert.ok(
    panelWidth >= 400 && panelWidth <= 440,
    `The temporary-chat-only right panel was ${panelWidth}px wide instead of about 420px`
  )
  await captureVerificationScreenshot(control, '01-side-chat-compact-width.png')

  await control.command('dropFile', sideComposerSelector, {
    filename: SIDE_CHAT_FILENAME,
    mimeType: 'image/png',
    value: IMAGE_ARTIFACT_BASE64,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('attachment-badge') &&
      !snapshot.testIds.includes('uploading-attachment-badge'),
    'The side-chat attachment did not finish uploading',
    DEFAULT_STEP_TIMEOUT_MS,
    sideChatSelector
  )
  const mainBeforeSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
  assert.equal(
    mainBeforeSend.testIds.includes('attachment-badge'),
    false,
    'Uploading in the side chat leaked an attachment into the main composer'
  )
  await captureVerificationScreenshot(control, '02-side-chat-attachment-isolated.png')

  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_PROMPT })
  assert.equal(
    await control.command('getValue', sideComposerSelector),
    SIDE_CHAT_PROMPT,
    'The side-chat prompt did not reach the isolated composer'
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, COMPOSER_READY_STABILITY_MS))
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.awaitScenarioRequestCount('side_chat_attachment', 1)
  await control.command('waitFor', `${sideChatSelector} [data-testid="message-assistant"]`, {
    text: SIDE_CHAT_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const sideAfterSend = JSON.parse(await control.command('snapshot', sideChatSelector))
  assert.equal(
    sideAfterSend.testIds.includes('attachment-badge'),
    false,
    'The sent side-chat attachment was not cleared from its composer'
  )
  const mainAfterSend = JSON.parse(await control.command('snapshot', mainComposerSelector))
  assert.equal(
    mainAfterSend.testIds.includes('attachment-badge'),
    false,
    'Sending the side chat leaked an attachment into the main composer'
  )
  await captureVerificationScreenshot(control, '03-side-chat-sent-main-clean.png')

  control.setScenario('side_chat_queue')
  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_QUEUE_INITIAL })
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.awaitScenarioRequestCount('side_chat_queue', 1)
  await control.command('fill', sideComposerSelector, { value: SIDE_CHAT_QUEUE_FOLLOW_UP })
  await control.command('click', `${sideChatSelector} [data-testid="send-message-button"]`)
  await control.command('waitFor', `${sideChatSelector} [data-testid="conversation-queue-panel"]`, {
    text: SIDE_CHAT_QUEUE_FOLLOW_UP,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const queuedSideChat = JSON.parse(await control.command('snapshot', sideChatSelector))
  assert.equal(
    queuedSideChat.testIds.includes('chat-input-error'),
    false,
    'The side chat exposed a runtime busy error instead of queueing the follow-up'
  )
  await captureVerificationScreenshot(control, '04-side-chat-follow-up-queued.png')
  control.releaseSideChatQueueResponse()

  await control.command('click', '[data-testid="toggle-right-workspace-panel-expanded-button"]')
  await control.command(
    'waitFor',
    `${sideChatSelector} [data-testid="restore-conversation-from-expanded-workspace-button"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await control.command('finishAnimations', 'body')
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="project-chat-composer"]`
      )
    ),
    1,
    'Expanded temporary chat rendered more than its own composer'
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-card"]`
      )
    ),
    0,
    'The main task composer remained visible behind the expanded temporary chat'
  )
  await captureVerificationScreenshot(control, '05-side-chat-expanded-single-composer.png')

  await control.command(
    'click',
    `${sideChatSelector} [data-testid="restore-conversation-from-expanded-workspace-button"]`
  )
  await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('finishAnimations', 'body')
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="project-chat-composer"]`
      )
    ),
    2,
    'Restoring the split view did not restore the two independent composers'
  )
  await captureVerificationScreenshot(control, '05-side-chat-restored-two-composers.png')
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')

  const requests = control.scenarioRequests.get('side_chat_attachment') ?? []
  assert.equal(requests.length, 1, 'The side chat did not send exactly one model request')
  const requestText = JSON.stringify(requests[0].body)
  assert.ok(requestText.includes(SIDE_CHAT_PROMPT), 'The side-chat prompt was not forwarded')
  assert.ok(requestText.includes(SIDE_CHAT_FILENAME), 'The side-chat attachment was not forwarded')
}

async function verifyReconnectRecovery({ composerSelector, control }) {
  control.setScenario('reconnect')
  await sendPromptUntilScenarioRequest(control, composerSelector, RECONNECT_PROMPT, 'reconnect')
  await withTimeout(
    control.awaitReconnectResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'The reconnect response stream did not start'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="thinking-indicator"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-01-streaming.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.disconnectReconnectResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="runtime-reconnecting-status"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-02-reconnecting.png',
    ACTIVE_WORKBENCH_SELECTOR
  )

  await withTimeout(
    control.awaitScenarioRequestCount('reconnect', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'Codex did not retry the disconnected response stream'
  )
  control.releaseReconnectResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: RECONNECT_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('runtime-reconnecting-status'),
    false,
    'The reconnecting status remained after model output recovered'
  )
  await captureVerificationScreenshot(
    control,
    'reconnect-03-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyRateLimitRecovery({ composerSelector, control }) {
  control.setScenario('rate_limit')
  await sendPromptUntilScenarioRequest(control, composerSelector, RATE_LIMIT_PROMPT, 'rate_limit')
  await withTimeout(
    control.awaitScenarioRequestCount('rate_limit', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The local model proxy did not retry the rate-limited request'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: RATE_LIMIT_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('assistant-error-card'),
    false,
    'The recovered rate-limit request rendered an assistant error'
  )
  assert.equal(
    control.scenarioRequests.get('rate_limit')?.length,
    2,
    'The rate-limit recovery did not issue exactly one retry'
  )
  await captureVerificationScreenshot(
    control,
    'rate-limit-01-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

async function verifyAnthropicEmptyResponseRecovery({ composerSelector, control }) {
  const anthropicModel = CLOUD_MODEL_CASES.find(model => model.protocol === 'anthropic')
  assert.ok(anthropicModel, 'The Anthropic cloud model fixture is missing')
  control.setScenario('anthropic_empty_response')
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, anthropicModel.optionId, anthropicModel.label)
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    ANTHROPIC_EMPTY_PROMPT,
    'anthropic_empty_response'
  )
  await withTimeout(
    control.awaitScenarioRequestCount('anthropic_empty_response', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'Codex did not retry the empty Anthropic response'
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: ANTHROPIC_EMPTY_COMPLETION_TEXT, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  assert.equal(
    control.scenarioRequests.get('anthropic_empty_response')?.length,
    2,
    'The empty Anthropic response did not recover with exactly one retry'
  )
  const recoveredSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    recoveredSnapshot.testIds.includes('assistant-error-card'),
    false,
    'The recovered Anthropic response rendered an assistant error'
  )
  await captureVerificationScreenshot(
    control,
    'anthropic-empty-01-recovered.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
}

function createSse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function codexRequestKind(body) {
  const metadata = body.client_metadata?.['x-codex-turn-metadata']
  if (typeof metadata !== 'string') return null

  try {
    return JSON.parse(metadata).request_kind ?? null
  } catch {
    return null
  }
}

function latestModelInputText(body) {
  const input = Array.isArray(body.input) ? body.input.at(-1) : body.input
  const message = Array.isArray(body.messages) ? body.messages.at(-1) : null
  return JSON.stringify(input ?? message ?? '')
}

function responseCreated(id) {
  return {
    type: 'response.created',
    response: {
      id,
      object: 'response',
      status: 'in_progress',
      output: [],
    },
  }
}

function responseCompleted(id, output) {
  return {
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      status: 'completed',
      ...(output ? { output } : {}),
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function responseFailed(id, message) {
  return {
    type: 'response.failed',
    response: {
      id,
      status: 'failed',
      error: { code: 'context_length_exceeded', message },
    },
  }
}

function functionCall(callId, name, argumentsValue) {
  return [
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
      },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    },
  ]
}

function namespacedFunctionCall(callId, namespace, name, argumentsValue) {
  return functionCall(callId, name, argumentsValue).map(event => ({
    ...event,
    item: { ...event.item, namespace },
  }))
}

function toolSearchCall(callId, argumentsValue) {
  const item = {
    type: 'tool_search_call',
    call_id: callId,
    execution: 'client',
    arguments: argumentsValue,
  }
  return [
    {
      type: 'response.output_item.added',
      item: { ...item, status: 'in_progress' },
    },
    {
      type: 'response.output_item.done',
      item: { ...item, status: 'completed' },
    },
  ]
}

function customToolCall(callId, name, input) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input,
    },
  }
}

let assistantMessageSequence = 0

function assistantMessage(text) {
  const messageId = `wework-e2e-message-${assistantMessageSequence++}`
  return {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      id: messageId,
      content: [{ type: 'output_text', text, annotations: [] }],
      phase: 'final_answer',
    },
  }
}

function encryptedReasoningItem(id, encryptedContent) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'reasoning',
      id,
      summary: [],
      encrypted_content: encryptedContent,
    },
  }
}

function streamingMarkdownReport() {
  const section = index =>
    [
      `### Memory section ${index}`,
      '',
      '| Metric | Value |',
      '| --- | ---: |',
      `| Section | ${index} |`,
      '| Rendering | Streaming Markdown |',
      '',
      '```ts',
      `export const memorySection${index} = { enabled: true, index: ${index} }`,
      '```',
      '',
      'This section exercises incremental Markdown parsing, syntax highlighting, React reconciliation, and WebKit layout allocation.',
      '',
    ].join('\n')
  return `${Array.from({ length: 80 }, (_, index) => section(index + 1)).join('\n')}\n${MEMORY_COMPLETION_TEXT}`
}

function streamingTextEvents(id, text) {
  const itemId = `${id}-message`
  const chunks = text.match(/[\s\S]{1,48}/g) ?? []
  return {
    chunks,
    start: [
      responseCreated(id),
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      },
      {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ],
    finish: [
      {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      },
      responseCompleted(id),
    ],
    itemId,
  }
}

function localProtocolCase(modelId) {
  return LOCAL_MODEL_CASES.find(model => model.modelId === modelId) ?? null
}

function localProtocolPrompt(model, phase) {
  return `WEWORK_LOCAL_MODEL_${model.protocol.toUpperCase()}_${phase}`
}

function localProtocolArtifact(model) {
  return `wework-local-${model.protocol}.txt`
}

function localProtocolArtifactContent(model) {
  return `WEWORK_LOCAL_${model.protocol.toUpperCase()}_APPLY_PATCH`
}

function localProtocolPatch(model) {
  return [
    '*** Begin Patch',
    `*** Add File: ${localProtocolArtifact(model)}`,
    `+${localProtocolArtifactContent(model)}`,
    '*** End Patch',
  ].join('\n')
}

function localModelSwitchCommand() {
  return `printf '%s' '${LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT}' > '${LOCAL_MODEL_SWITCH_ARTIFACT}'`
}

function matrixCaseId(model) {
  return `${model.execution}-${model.source}-${model.protocol}`
}

function matrixTextPrompt(model) {
  return `${MODEL_PROTOCOL_MATRIX_TEXT_PREFIX}_${matrixCaseId(model).toUpperCase()}`
}

function matrixTextCompletion(model) {
  return `${matrixTextPrompt(model)}_COMPLETE`
}

function matrixToolPrompt(model) {
  return `${MODEL_PROTOCOL_MATRIX_TOOL_PREFIX}_${matrixCaseId(model).toUpperCase()}`
}

function matrixToolCompletion(model) {
  return `${matrixToolPrompt(model)}_COMPLETE`
}

function matrixToolPreamble(model) {
  return `${matrixToolPrompt(model)}_RUNNING_TOOL`
}

function matrixArtifact(model) {
  return `wework-matrix-${matrixCaseId(model)}.txt`
}

function matrixArtifactContent(model) {
  return `WEWORK_MATRIX_${matrixCaseId(model).toUpperCase()}_APPLY_PATCH`
}

function matrixPatch(model) {
  return [
    '*** Begin Patch',
    `*** Add File: ${matrixArtifact(model)}`,
    `+${matrixArtifactContent(model)}`,
    '*** End Patch',
  ].join('\n')
}

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
    })
    request.once('end', () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.once('error', reject)
  })
}

function readRawRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    request.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    request.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    request.once('error', reject)
  })
}

function parseTelemetryPayload(rawBody) {
  try {
    return JSON.parse(rawBody)
  } catch {
    const encoded = new URLSearchParams(rawBody).get('data')
    assert.ok(encoded, 'The PostHog telemetry request did not contain a JSON payload')
    return JSON.parse(encoded)
  }
}

function telemetryEvents(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.batch)) return payload.batch
  return payload?.event ? [payload] : []
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function requestContainsToolOutput(request, callId) {
  const containsOutput = value => {
    if (Array.isArray(value)) return value.some(containsOutput)
    if (!value || typeof value !== 'object') return false

    const type = value.type
    const isToolOutput =
      type === 'function_call_output' ||
      type === 'custom_tool_call_output' ||
      type === 'tool_search_output'
    if (isToolOutput && (!callId || value.call_id === callId)) return true

    return Object.values(value).some(containsOutput)
  }

  return containsOutput(request.input ?? [])
}

function requestAdvertisesShellTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  return tools.some(tool => tool?.name === 'exec_command' || tool?.name === 'shell_command')
}

function requestAdvertisesViewImageTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  return tools.some(tool => tool?.name === 'view_image')
}

function selectTool(request, name, argumentsValue) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const names = new Set(tools.map(tool => tool?.name).filter(Boolean))
  assert.ok(names.has(name), `Real Codex did not advertise ${name}: ${[...names].join(', ')}`)
  return { name, arguments: argumentsValue }
}

function selectOfficialPluginMcpTool(request, argumentsValue) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  assert.ok(
    tools.some(tool => tool?.type === 'tool_search'),
    'Real Codex did not retain tool_search after loading the official plugin MCP tool'
  )
  const namespaces = tools.filter(
    candidate => candidate?.type === 'namespace' && candidate.name === OFFICIAL_PLUGIN_MCP_NAMESPACE
  )
  assert.equal(
    namespaces.length,
    1,
    'Real Codex did not directly advertise exactly one official plugin MCP namespace'
  )
  const namespace = namespaces[0]
  const matchingTools = namespace.tools?.filter(
    candidate =>
      candidate?.type === 'function' &&
      candidate.description?.includes(OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION)
  )
  assert.equal(
    matchingTools?.length,
    1,
    'The official plugin MCP namespace did not expose exactly one destination confirmation tool'
  )
  const tool = matchingTools[0]
  assert.ok(
    tool.description.includes(`plugin \`${OFFICIAL_PLUGIN_DISPLAY_NAME}\``),
    'The direct MCP tool did not retain official plugin provenance'
  )
  assert.deepEqual(
    new Set(tool.parameters?.required),
    new Set(['workspacePath', 'targetPath']),
    'The direct MCP tool did not require both workspace confinement inputs'
  )
  return { namespace: namespace.name, name: tool.name, arguments: argumentsValue }
}

function assertMcpNamespaceDeferred(request, namespaceName) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  assert.ok(
    !tools.some(tool => tool?.type === 'namespace' && tool.name === namespaceName),
    `Real Codex advertised MCP namespace ${namespaceName} before tool discovery`
  )
}

function selectToolSearch(request, query) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const searchTools = tools.filter(tool => tool?.type === 'tool_search')
  assert.equal(searchTools.length, 1, 'Real Codex did not advertise exactly one tool_search')
  return { query, limit: 5 }
}

function selectMcpTool(request, namespaceName, toolName, argumentsValue) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const namespace = tools.find(
    candidate => candidate?.type === 'namespace' && candidate.name === namespaceName
  )
  assert.ok(namespace, `Real Codex did not advertise MCP namespace ${namespaceName}`)
  const tool = namespace.tools?.find(
    candidate => candidate?.type === 'function' && candidate.name === toolName
  )
  assert.ok(tool, `MCP namespace ${namespaceName} did not advertise ${toolName}`)
  return { namespace: namespace.name, name: tool.name, arguments: argumentsValue }
}

function selectShellTool(request, workspacePath) {
  return selectShellToolCommand(request, 'pwd', workspacePath)
}

function selectShellToolCommand(request, command, workspacePath) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  if (tools.some(tool => tool?.name === 'exec_command')) {
    return selectTool(request, 'exec_command', {
      cmd: command,
      workdir: workspacePath,
      yield_time_ms: 1000,
    })
  }
  if (tools.some(tool => tool?.name === 'shell_command')) {
    return selectTool(request, 'shell_command', {
      command,
      workdir: workspacePath,
      timeout_ms: 10_000,
    })
  }
  throw new Error('Real Codex did not advertise a supported shell tool')
}

function selectApplyPatchTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  assert.ok(
    tools.some(tool => tool?.name === 'apply_patch'),
    `Real Codex did not advertise apply_patch: ${tools
      .map(tool => tool?.name)
      .filter(Boolean)
      .join(', ')}`
  )
  return [
    '*** Begin Patch',
    `*** Add File: ${ARTIFACT_NAME}`,
    `+${ARTIFACT_CONTENT}`,
    '*** End Patch',
  ].join('\n')
}

function selectCloudApplyPatchTool(request) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const applyPatch = tools.find(tool => tool?.name === 'apply_patch')
  assert.ok(applyPatch, 'Real cloud Codex did not advertise apply_patch')
  assert.equal(
    applyPatch.type,
    'custom',
    'Native Responses cloud models must preserve Codex custom tools'
  )
  return [
    '*** Begin Patch',
    `*** Add File: ${CLOUD_ARTIFACT_NAME}`,
    `+${CLOUD_ARTIFACT_CONTENT}`,
    '*** End Patch',
  ].join('\n')
}

function selectViewImageTool(request, workspacePath) {
  return selectTool(request, 'view_image', {
    path: join(workspacePath, IMAGE_ARTIFACT_NAME),
  })
}

function snapshotHasAssistantActivity(snapshot) {
  return (
    snapshot.testIds.includes('thinking-indicator') ||
    snapshot.testIds.includes('process-text-block')
  )
}

async function verifyActiveGoalIdleUnreadLifecycle({ composerSelector, control, executorLogPath }) {
  control.setScenario('goal_idle')
  const executorLogOffset = (await readFile(executorLogPath, 'utf8').catch(() => '')).length
  const taskRowsBeforeGoal = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', '[data-testid="goal-draft-pill"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(control, composerSelector, GOAL_IDLE_PROMPT, 'goal_idle')
  const goalTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeGoal,
    'WEWORK_DESKTOP_E2E_GOAL_IDLE'
  )
  const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
  const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
  const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'The running Goal turn did not render a consistent sidebar, composer, and message state'
  )
  const runningDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot => snapshot.pane?.status?.isAssistantStreaming === true,
    'The running Goal turn never entered visible streaming state'
  )
  assert.equal(
    runningDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    true,
    'The running Goal turn was not authoritative runtime work'
  )
  assert.equal(
    runningDebugSnapshot.pane?.status?.isAssistantStreaming,
    true,
    'The running Goal turn did not expose a streaming assistant message'
  )
  assert.equal(
    runningDebugSnapshot.pane?.status?.isBusy,
    true,
    'The running Goal turn did not keep the composer busy'
  )
  await captureVerificationScreenshot(control, 'goal-idle-01-running.png')

  control.releaseGoalIdleInitialResponse()
  await withTimeout(
    control.awaitScenarioRequestCount('goal_idle', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The active Goal did not start its automatic continuation'
  )
  const goalExecutorLog = (await readFile(executorLogPath, 'utf8')).slice(executorLogOffset)
  assert.equal(
    (goalExecutorLog.match(/codex shared goal turn awaiting/g) ?? []).length,
    1,
    `The Goal submission did not use exactly one Codex goal-started turn:\n${goalExecutorLog}`
  )
  assert.equal(
    (goalExecutorLog.match(/codex shared turn request started/g) ?? []).length,
    0,
    `The Goal submission also issued turn/start and created an overlapping turn:\n${goalExecutorLog}`
  )

  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes(goalRunningTestId) &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('assistant-error-card') &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      snapshot.text.includes(GOAL_IDLE_PROMPT) &&
      snapshot.text.includes(GOAL_IDLE_INITIAL_TEXT),
    'The between-turn Goal gap did not preserve the sidebar, composer, message, and unread state',
    DEFAULT_STEP_TIMEOUT_MS
  )
  const continuationDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.pane?.status?.isAssistantStreaming === true &&
      snapshot.pane?.status?.taskExecution?.running === true,
    'The automatic Goal continuation never entered visible streaming state'
  )
  assert.equal(
    continuationDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    true,
    'The active Goal stopped being visibly running during automatic continuation'
  )
  assert.equal(
    continuationDebugSnapshot.pane?.goal?.status,
    'active',
    'The Goal stopped being active during automatic continuation'
  )
  assert.equal(
    continuationDebugSnapshot.pane?.status?.taskExecution?.running,
    true,
    'The active Goal lost its unified running state during automatic continuation'
  )
  assert.equal(
    continuationDebugSnapshot.pane?.status?.isBusy,
    true,
    'The active Goal released the composer during automatic continuation'
  )
  await captureVerificationScreenshot(control, 'goal-idle-02-automatic-continuation.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      snapshot.testIds.includes(goalRunningTestId),
    'The background Goal continuation stopped running or became unread'
  )
  await captureVerificationScreenshot(control, 'goal-idle-03-background-unread-free.png')

  control.releaseGoalIdleResponse()
  await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'goal-idle-04-settled-unread.png')
  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GOAL_IDLE_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const completedDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    completedDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    false,
    `The completed Goal remained authoritative runtime work: ${JSON.stringify(
      completedDebugSnapshot.workbench?.runningState ?? null
    )}`
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      !snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('assistant-error-card') &&
      !snapshot.testIds.includes('goal-status-bar'),
    'Opening the completed Goal task did not render a consistent final state',
    DEFAULT_STEP_TIMEOUT_MS
  )
  const settledDebugSnapshot = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    settledDebugSnapshot.pane?.goal ?? null,
    null,
    'The completed Goal remained visible as an active pane goal'
  )
  assert.equal(
    settledDebugSnapshot.pane?.status?.isBusy,
    false,
    'The completed Goal kept the composer busy'
  )
}

async function verifyTaskSupervisorLifecycle({ composerSelector, control }) {
  await ensureExperimentalFeaturesEnabled(control)
  control.setScenario('supervisor')
  const taskRowsBeforeSupervisor = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('waitFor', '[data-testid="task-supervisor-toggle-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="task-supervisor-toggle-button"]')
  await control.command('click', '[data-testid="task-supervisor-mode-auto"]')
  await control.command('fill', '[data-testid="task-supervisor-instructions"]', {
    value: SUPERVISOR_PRINCIPLES,
  })
  await control.command('click', '[data-testid="task-supervisor-save-button"]')
  await control.command('waitFor', '[data-testid="pending-supervisor-indicator"]', {
    text: '监督将在任务开始后生效',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'supervisor-pending-context.png')
  await sendPromptUntilScenarioRequest(control, composerSelector, SUPERVISOR_PROMPT, 'supervisor')
  control.releaseSupervisorInitialResponse()
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: SUPERVISOR_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('pending-supervisor-indicator'),
    'The pre-task supervisor indicator remained after the task was created'
  )

  await withTimeout(
    control.awaitScenarioRequestCount('supervisor', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The supervisor evaluator did not inspect the completed task'
  )
  await withTimeout(
    control.awaitScenarioRequestCount('supervisor', 3),
    DEFAULT_STEP_TIMEOUT_MS,
    'Auto-correction did not send a normal follow-up turn after the task became idle'
  )
  await withTimeout(
    control.awaitSupervisorCorrectionResponseStarted(),
    DEFAULT_STEP_TIMEOUT_MS,
    'The supervisor correction response did not start'
  )
  const supervisorTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeSupervisor,
    'WEWORK_DESKTOP_E2E_SUPERVISOR'
  )
  const supervisorTaskId = supervisorTaskRowTestId.replace('runtime-local-task-row-', '')
  const supervisorRunningTestId = `runtime-local-task-running-${supervisorTaskId}`
  await control.command('waitFor', `[data-testid="${supervisorRunningTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const beforeStaleSettlement = JSON.parse(
    await control.command('getWorkbenchDebugSnapshot', 'body')
  )
  assert.equal(
    beforeStaleSettlement.workbench?.currentRuntimeTask?.taskId,
    supervisorTaskId,
    'The supervisor correction task was not current before replaying the stale settlement'
  )
  await control.command('dispatchRuntimeLifecycleEvent', 'body', {
    value: JSON.stringify({
      address: beforeStaleSettlement.workbench.currentRuntimeTask,
      type: 'turn_settled',
      turnId: 'stale-supervisor-turn',
    }),
  })
  try {
    const runningSnapshot = await waitForWorkbenchDebugState(
      control,
      snapshot =>
        snapshot.workbench?.currentRuntimeTask?.taskId === supervisorTaskId &&
        snapshot.workbench?.lifecycleCurrentTaskRunning === true &&
        snapshot.pane?.status?.isBusy === true,
      'The live supervisor correction was not represented as running'
    )
    assert.equal(
      runningSnapshot.pane?.status?.taskExecution?.running,
      true,
      'The supervisor correction had a live executor response but task execution was idle'
    )
    await captureVerificationScreenshot(control, 'supervisor-01-correction-running.png')
  } finally {
    control.releaseSupervisorCorrectionResponse()
  }
  await control.command('waitFor', '[data-testid="message-user"]', {
    text: SUPERVISOR_CORRECTION,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: SUPERVISOR_CORRECTION_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('task-supervisor-suggestion'),
    'Auto-correction incorrectly rendered an approval card'
  )
}

async function verifyGoalRestartRecoveryLifecycle({
  composerSelector,
  control,
  executorLogPath,
  restartDesktopApp,
}) {
  control.setScenario('goal_restart')
  const taskRowsBeforeGoal = new Set(
    JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
      testId.startsWith('runtime-local-task-row-')
    )
  )
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  await control.command('click', '[data-testid="add-context-button"]')
  await control.command('click', '[data-testid="set-goal-button"]')
  await control.command('waitFor', '[data-testid="goal-draft-pill"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await sendPromptUntilScenarioRequest(
    control,
    composerSelector,
    GOAL_RESTART_PROMPT,
    'goal_restart'
  )
  const goalTaskRowTestId = await waitForNewTaskRow(
    control,
    taskRowsBeforeGoal,
    'WEWORK_DESKTOP_E2E_GOAL_RESTART'
  )
  const goalTaskId = goalTaskRowTestId.replace('runtime-local-task-row-', '')
  const goalUnreadTestId = `runtime-local-task-unread-dot-${goalTaskId}`
  const goalRunningTestId = `runtime-local-task-running-${goalTaskId}`
  await withTimeout(
    control.awaitScenarioRequestCount('goal_restart', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The active Goal did not enter automatic continuation before restart'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) &&
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshotHasAssistantActivity(snapshot) &&
      !snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      snapshot.text.includes(GOAL_RESTART_INITIAL_TEXT),
    'The user did not see the Goal working before Wework restarted'
  ).catch(async error => {
    const debugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; workbench debug: ${JSON.stringify(
        {
          currentRuntimeTask: debugSnapshot.workbench?.currentRuntimeTask ?? null,
          lifecycleCurrentTaskRunning: debugSnapshot.workbench?.lifecycleCurrentTaskRunning ?? null,
          goal: debugSnapshot.pane?.goal ?? null,
          goalContinuing: debugSnapshot.pane?.goalContinuing ?? null,
          goalDraftActive: debugSnapshot.pane?.goalDraftActive ?? null,
        }
      )}`
    )
  })
  await captureVerificationScreenshot(control, 'goal-restart-01-working-before-restart.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  const executorReadyBeforeRestart = await waitForExecutorReadyEvidence(executorLogPath)
  const executorProcessIdBeforeRestart = executorReadyBeforeRestart.processIds.at(-1)
  assert.ok(executorProcessIdBeforeRestart, 'The original executor process ID was not recorded')

  await restartDesktopApp()

  const executorReadyAfterRestart = await waitForExecutorReadyEvidence(
    executorLogPath,
    DEFAULT_STEP_TIMEOUT_MS,
    executorReadyBeforeRestart.processIds.length + 1
  )
  const executorProcessIdAfterRestart = executorReadyAfterRestart.processIds.at(-1)
  assert.ok(executorProcessIdAfterRestart, 'The restarted executor process ID was not recorded')
  assert.notEqual(
    executorProcessIdAfterRestart,
    executorProcessIdBeforeRestart,
    'Restarting Wework reused the executor process that owned the active Goal'
  )
  assert.equal(
    processIsAlive(executorProcessIdBeforeRestart),
    false,
    'The original executor remained alive after a full Wework restart'
  )

  await control.command('waitFor', `[data-testid="${goalTaskRowTestId}"]`, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalTaskRowTestId) &&
      !snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'The interrupted Goal looked running or completed after Wework restarted',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'goal-restart-02-returned-not-running.png')

  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('goal-status-bar') &&
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      snapshot.text.includes(GOAL_RESTART_PROMPT),
    'Opening the interrupted Goal did not present a stable, user-controlled recovery state',
    WORKBENCH_READY_TIMEOUT_MS
  )
  const interruptedDebugSnapshot = await waitForWorkbenchDebugState(
    control,
    snapshot =>
      snapshot.workbench?.currentRuntimeTask?.taskId === goalTaskId &&
      snapshot.workbench?.lifecycleCurrentTaskRunning === false &&
      snapshot.pane?.goal?.status === 'active',
    'The interrupted Goal did not finish hydrating after Wework restarted'
  )
  assert.equal(
    interruptedDebugSnapshot.workbench?.lifecycleCurrentTaskRunning,
    false,
    'Opening the interrupted Goal changed the executor-owned running state'
  )
  assert.equal(
    interruptedDebugSnapshot.pane?.goal?.status,
    'active',
    'Restarting Wework discarded the persisted Goal'
  )
  await captureVerificationScreenshot(control, 'goal-restart-03-opened-waiting-for-user.png')

  const requestCountBeforeUserResume = control.scenarioRequests.get('goal_restart')?.length ?? 0
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  assert.equal(
    control.scenarioRequests.get('goal_restart')?.length ?? 0,
    requestCountBeforeUserResume,
    'The interrupted Goal resumed without an explicit user action'
  )

  control.markGoalRestartResumeRequested()
  await sendPrompt(control, composerSelector, GOAL_RESTART_RESUME_PROMPT)
  await withTimeout(
    control.awaitScenarioRequestCount('goal_restart', requestCountBeforeUserResume + 1),
    DEFAULT_STEP_TIMEOUT_MS,
    'The executor did not resume the Goal after explicit user input'
  )
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes(goalRunningTestId) &&
      snapshot.testIds.includes('pause-response-button') &&
      snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes(goalUnreadTestId),
    'The user did not see consistent running feedback after explicitly resuming the Goal'
  )
  await captureVerificationScreenshot(control, 'goal-restart-04-explicitly-resumed.png')

  await control.command('click', '[data-testid="new-chat-button"]')
  await waitForBlankConversation(control, composerSelector)
  control.releaseGoalRestartResponse()
  await control.command('waitFor', `[data-testid="${goalUnreadTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'goal-restart-05-completed-unread.png')

  await control.command('clickWhenEnabled', `[data-testid="${goalTaskRowTestId}"]`, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: GOAL_RESTART_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('send-message-button') &&
      !snapshot.testIds.includes(goalUnreadTestId) &&
      !snapshot.testIds.includes(goalRunningTestId) &&
      !snapshot.testIds.includes('pause-response-button') &&
      !snapshot.testIds.includes('thinking-indicator') &&
      !snapshot.testIds.includes('goal-status-bar'),
    'The recovered Goal did not settle into a consistent final state',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'goal-restart-06-completed-read.png')
}

class RealCloudEnvironment {
  constructor({ codexBinary, executorBinary, modelServerUrl, workspacePath }) {
    this.codexBinary = codexBinary
    this.executorBinary = executorBinary
    this.modelServerUrl = modelServerUrl
    this.workspacePath = workspacePath
  }

  async start() {
    this.redisPort = await reservePort()
    this.backendPort = await reservePort()
    this.backendUrl = `http://127.0.0.1:${this.backendPort}`
    this.socketUrl = `http://localhost:${this.backendPort}`
    this.databasePath = join(resultDir, 'cloud-backend.sqlite3')
    this.backendLogPath = join(resultDir, 'cloud-backend.log')
    this.redisLogPath = join(resultDir, 'cloud-redis.log')
    this.remoteExecutorLogPath = join(resultDir, 'cloud-executor.log')

    this.redis = spawn(
      'redis-server',
      ['--port', String(this.redisPort), '--save', '', '--appendonly', 'no'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await Promise.all([
      appendProcessOutput(this.redis.stdout, this.redisLogPath),
      appendProcessOutput(this.redis.stderr, this.redisLogPath),
    ])

    const backendEnv = {
      ...process.env,
      DATABASE_URL: `sqlite:///${this.databasePath}`,
      REDIS_URL: `redis://127.0.0.1:${this.redisPort}/0`,
      SECRET_KEY: `wework-desktop-e2e-${process.pid}`,
      INTERNAL_SERVICE_TOKEN: `wework-desktop-e2e-internal-${process.pid}`,
      GIT_TOKEN_AES_KEY: '12345678901234567890123456789012',
      GIT_TOKEN_AES_IV: '1234567890123456',
      WEGENT_SOCKET_URL: this.socketUrl,
      DB_AUTO_MIGRATE: 'false',
      INIT_DATA_ENABLED: 'true',
    }
    await runChecked('uv', ['run', 'alembic', 'upgrade', 'head'], {
      cwd: join(repoDir, 'backend'),
      env: backendEnv,
    })
    this.backend = spawn(
      'uv',
      ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.backendPort)],
      {
        cwd: join(repoDir, 'backend'),
        env: backendEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    await Promise.all([
      appendProcessOutput(this.backend.stdout, this.backendLogPath),
      appendProcessOutput(this.backend.stderr, this.backendLogPath),
    ])
    await waitForUrl(
      `${this.backendUrl}/api/docs`,
      `Real cloud backend did not start; see ${this.backendLogPath}`
    )

    const password = `wework-desktop-e2e-${process.pid}`
    const setup = await fetchJson(`${this.backendUrl}/api/auth/admin-password/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    this.authToken = setup.access_token
    assert.ok(this.authToken, 'Real cloud backend did not return an authentication token')
    await this.seedCloudProtocolModels()
    await this.seedCloudVisionSidecarModels()

    const remoteHome = join(resultDir, 'cloud-executor-home')
    this.remoteCodexHome = join(remoteHome, 'codex')
    await writeCodexConfig(this.remoteCodexHome, this.modelServerUrl)
    const remoteEnv = {
      ...process.env,
      CODEX_BIN: this.codexBinary,
      CODEX_HOME: this.remoteCodexHome,
      HOME: remoteHome,
      WEGENT_CODEX_HOME: this.remoteCodexHome,
      WEGENT_EXECUTOR_HOME: remoteHome,
      WEGENT_EXECUTOR_LOG_DIR: resultDir,
      WEGENT_EXECUTOR_LOG_FILE: 'cloud-executor-runtime.log',
      EXECUTOR_MODE: 'local',
      WEGENT_BACKEND_URL: this.backendUrl,
      WEGENT_SOCKET_URL: this.socketUrl,
      WEGENT_AUTH_TOKEN: this.authToken,
      DEVICE_ID: CLOUD_DEVICE_ID,
      DEVICE_NAME: 'Wework E2E Cloud Device',
      DEVICE_TYPE: 'cloud',
      BIND_SHELL: 'claudecode',
      LOCAL_WORKSPACE_ROOT: dirname(this.workspacePath),
      WEGENT_WORKSPACE_ROOTS: this.workspacePath,
      WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
    }
    delete remoteEnv.WEGENT_APP_IPC_DEVICE_ID
    this.remoteExecutor = spawn(this.executorBinary, [], {
      cwd: weworkDir,
      env: remoteEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    await Promise.all([
      appendProcessOutput(this.remoteExecutor.stdout, this.remoteExecutorLogPath),
      appendProcessOutput(this.remoteExecutor.stderr, this.remoteExecutorLogPath),
    ])
    await this.waitForDevice()
  }

  async seedCloudProtocolModels() {
    const items = CLOUD_MODEL_CASES.map(model => ({
      name: model.optionId,
      env: {
        model: model.protocol === 'anthropic' ? 'claude' : 'openai',
        model_id: model.modelId,
        base_url: `${this.modelServerUrl}/v1`,
        api_key: MODEL_API_KEY,
      },
      is_active: true,
      wework_available: true,
      protocol:
        model.protocol === 'responses'
          ? 'openai-responses'
          : model.protocol === 'chat'
            ? 'openai'
            : 'anthropic-messages',
      ...(model.protocol === 'responses'
        ? { api_format: 'responses' }
        : model.protocol === 'chat'
          ? { api_format: 'chat/completions' }
          : {}),
    }))
    await fetchJson(`${this.backendUrl}/api/models/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(items),
    })
  }

  async seedCloudVisionSidecarModels() {
    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    }
    const createModel = model =>
      fetchJson(`${this.backendUrl}/api/v1/namespaces/default/models`, {
        method: 'POST',
        headers,
        body: JSON.stringify(model),
      })

    await createModel({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: 'desktop-e2e-cloud-vision-sidecar',
        namespace: 'default',
        displayName: 'Desktop E2E Cloud Vision Sidecar',
      },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: CLOUD_VISION_SIDECAR_CASE.sidecarModelId,
            base_url: `${this.modelServerUrl}/v1`,
            api_key: MODEL_API_KEY,
          },
        },
        protocol: 'openai',
        apiFormat: 'chat/completions',
        modelType: 'llm',
        isWeworkAvailable: true,
        modelCapabilities: {
          supportsImage: true,
        },
      },
    })

    const unifiedModels = await fetchJson(
      `${this.backendUrl}/api/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework`,
      { headers }
    )
    const sidecar = unifiedModels.data?.find(
      model => model.name === 'desktop-e2e-cloud-vision-sidecar' && model.type === 'user'
    )
    assert.ok(sidecar, 'The cloud vision sidecar fixture was not returned by model aggregation')
    assert.equal(
      typeof sidecar.resourceUserId,
      'number',
      'The cloud vision sidecar fixture did not expose its resource owner'
    )

    await createModel({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: {
        name: CLOUD_VISION_SIDECAR_CASE.mainOptionId,
        namespace: 'default',
        displayName: CLOUD_VISION_SIDECAR_CASE.mainLabel,
      },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: CLOUD_VISION_SIDECAR_CASE.mainModelId,
            base_url: `${this.modelServerUrl}/v1`,
            api_key: MODEL_API_KEY,
          },
          visionSidecarModel: {
            modelName: sidecar.name,
            modelType: sidecar.type,
            namespace: sidecar.namespace,
            resourceUserId: sidecar.resourceUserId,
            apiFormat: 'openai-chat-completions',
          },
        },
        protocol: 'openai-responses',
        apiFormat: 'responses',
        modelType: 'llm',
        isWeworkAvailable: true,
      },
    })
  }

  async setCodexUpstreamProtocol(protocol) {
    await writeCodexConfig(
      this.remoteCodexHome,
      this.modelServerUrl,
      '',
      codexUpstreamApiFormat(protocol)
    )
  }

  async waitForDevice() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/devices`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
      })
      if (response.ok) {
        const devices = await response.json()
        const device = devices.items?.find(item => item.device_id === CLOUD_DEVICE_ID)
        if (device?.status === 'online') return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error(`Real cloud executor did not register; see ${this.remoteExecutorLogPath}`)
  }

  async waitForWorkspaceRemoved(workspacePath) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
      const response = await fetch(`${this.backendUrl}/api/runtime-work`, {
        headers: { Authorization: `Bearer ${this.authToken}` },
      })
      if (response.ok) {
        const work = await response.json()
        const stillPresent = work.workspaces?.some(
          workspace => workspace.workspacePath === workspacePath
        )
        if (!stillPresent) return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
    throw new Error('The real cloud backend still returned the removed project')
  }

  async aliasCloudDeviceToCurrentApp() {
    const devices = await fetchJson(`${this.backendUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const localCandidates = (devices.items ?? []).filter(
      device => device.device_id !== CLOUD_DEVICE_ID && device.status === 'online'
    )
    const localDevice =
      localCandidates.find(device => device.device_type === 'app') ?? localCandidates[0]
    assert.ok(localDevice?.device_id, 'The connected local app device was not registered')
    assert.match(
      localDevice.device_id,
      /^[A-Za-z0-9._-]+$/,
      'The connected local app device ID is not safe for the SQLite fixture'
    )

    await runChecked('sqlite3', [
      this.databasePath,
      [
        'UPDATE kinds',
        `SET json = json_set(json, '$.spec.appDeviceId', '${localDevice.device_id}')`,
        `WHERE kind = 'Device' AND name = '${CLOUD_DEVICE_ID}';`,
      ].join(' '),
    ])

    const updated = await fetchJson(`${this.backendUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const cloudDevice = updated.items?.find(device => device.device_id === CLOUD_DEVICE_ID)
    assert.equal(
      cloudDevice?.app_device_id,
      localDevice.device_id,
      'The cloud route was not associated with the connected local app device'
    )
  }

  async cancelRunningTasks() {
    if (!this.backendUrl || !this.authToken) return
    const work = await fetchJson(`${this.backendUrl}/api/runtime-work`, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    })
    const workspaces = [
      ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
      ...(work.chats ?? []),
    ]
    const runningTasks = workspaces.flatMap(workspace =>
      (workspace.tasks ?? [])
        .filter(task => task.running)
        .map(task => ({
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          workspacePath: task.workspacePath,
        }))
    )
    await Promise.all(
      runningTasks.map(address =>
        fetchJson(`${this.backendUrl}/api/runtime-work/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(address),
        })
      )
    )
  }

  async stop() {
    try {
      await this.cancelRunningTasks()
    } catch (error) {
      await appendFile(
        this.remoteExecutorLogPath,
        `Cloud E2E cleanup could not cancel running tasks: ${String(error)}\n`
      )
    }
    await stopProcessGroup(this.remoteExecutor)
    await stopProcess(this.backend)
    await stopProcess(this.redis)
  }
}

async function verifyLocalExecutorUsesCloudSocketUrl(control, cloudEnvironment) {
  assert.notEqual(
    cloudEnvironment.socketUrl,
    cloudEnvironment.backendUrl,
    'Cloud E2E must use distinct backend and socket URLs'
  )
  const startedAt = Date.now()
  let executorLog = null
  while (Date.now() - startedAt < WORKBENCH_READY_TIMEOUT_MS) {
    executorLog = JSON.parse(await control.command('getLocalExecutorLog', 'body'))
    if (
      executorLog.backendUrl === cloudEnvironment.backendUrl &&
      executorLog.socketUrl === cloudEnvironment.socketUrl
    ) {
      return
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  assert.deepEqual(
    {
      backendUrl: executorLog?.backendUrl ?? null,
      socketUrl: executorLog?.socketUrl ?? null,
    },
    {
      backendUrl: cloudEnvironment.backendUrl,
      socketUrl: cloudEnvironment.socketUrl,
    },
    'Local executor did not apply the server-downlinked socket URL'
  )
}

class DesktopE2EServer {
  constructor(workspacePath, cloudWorkspacePath = workspacePath, desktopScenario = null) {
    this.workspacePath = workspacePath
    this.cloudWorkspacePath = cloudWorkspacePath
    this.desktopScenario = desktopScenario
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
    this.readyWaiters = []
    this.commandQueue = []
    this.commandResults = new Map()
    this.commandHistory = []
    this.modelRequests = []
    this.catalogRequests = []
    this.httpRequests = []
    this.telemetryRequests = []
    this.blockedCloudRequests = []
    this.blockedCloudResponses = new Set()
    this.blockedCloudWaiters = []
    this.failCloudModels = false
    this.cloudModelsAvailable = false
    this.failedCloudModelRequests = 0
    this.failedCloudModelWaiter = null
    this.sitesPluginInstalled = false
    this.miniProgramPluginInstalled = false
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
    this.sideChatQueueRelease = new Promise(resolvePromise => {
      this.resolveSideChatQueueRelease = resolvePromise
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
    this.cloudFollowUpRelease = new Promise(resolvePromise => {
      this.releaseCloudFollowUp = resolvePromise
    })
    this.goalIdleStage = 'initial'
    this.goalRestartStage = 'initial'
    this.goalRestartResumeRequested = false
    this.scenarioRequests = new Map()
    this.scenarioWaiters = new Map()
    this.localProtocolStates = new Map(
      LOCAL_MODEL_CASES.map(model => [model.protocol, { stage: 'initial', requests: [] }])
    )
    this.visionSidecarRequests = []
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
        'follow_up',
        'running_fork_follow_up',
        'fork_follow_up',
        'task_plan',
        'request_user_input',
        'window_lifecycle',
        'background_completion_restore',
        'background_follow_up_restore',
        'goal_idle',
        'goal_restart',
        'turn_navigation',
        'cancellation',
        'guidance_scroll',
        'queue_management',
        'retry',
        'rate_limit',
        'anthropic_empty_response',
        'reconnect',
        'checkpoint_task',
        'file_panel_anchor',
        'fresh_chat',
        'attachment_only',
        'pasted_zip_attachment',
        'pasted_workspace_paths',
        'dropped_workspace_paths',
        'memory',
        'concurrent_memory',
        'side_chat_attachment',
        'side_chat_queue',
        'cloud_initial',
        'cloud_follow_up',
        'model_protocol_matrix',
        'provider_switch_retry',
        'vision_sidecar',
        'view_image',
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

  releaseSideChatQueueResponse() {
    this.resolveSideChatQueueRelease()
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

  releaseGoalRestartResponse() {
    this.releaseGoalRestartResume()
  }

  markGoalRestartResumeRequested() {
    this.goalRestartResumeRequested = true
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
      this.commandResults.set(id, { clientId, resolve: resolvePromise, reject })
    })
    this.commandQueue.push({ clientId, command, rejectDelivery, resolveDelivery })
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
        user_name: 'wework-desktop-e2e-cloud-user',
        email: 'desktop-e2e@wework.local',
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
            capabilities: ['create', 'publish', 'delete'],
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
          ...(this.sitesPluginInstalled ? [installedSitesPlugin()] : []),
          ...(this.miniProgramPluginInstalled ? [installedMiniProgramPlugin()] : []),
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
      const installedPlugin = isSitesPlugin ? installedSitesPlugin() : installedMiniProgramPlugin()
      const installedPluginId = isSitesPlugin ? 601 : 602
      if (isSitesPlugin) {
        this.sitesPluginInstalled = true
      } else {
        this.miniProgramPluginInstalled = true
      }
      if (!body.device_id) {
        if (isSitesPlugin) {
          this.sitesConnectionBootstrapRequests += 1
        }
        json(response, 200, {
          plugin: installedPlugin,
          sync: null,
        })
        return
      }
      if (body.device_id !== 'local-device') {
        json(response, 422, {
          detail: 'A matching target device is required for application plugin synchronization',
        })
        return
      }
      json(response, 200, {
        plugin: installedPlugin,
        sync: {
          success: true,
          device_id: 'local-device',
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
              device_id: 'local-device',
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

    const modelProtocol =
      url.pathname === '/v1/responses' || url.pathname === '/responses'
        ? 'responses'
        : url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions'
          ? 'chat'
          : url.pathname === '/v1/messages' || url.pathname === '/messages'
            ? 'anthropic'
            : null
    if (request.method === 'POST' && modelProtocol) {
      await this.handleModelResponse(request, response, modelProtocol)
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
        this.controlWindowsByClient.delete(previousClientId)
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
      const commandIndex = this.commandQueue.findIndex(item => item.clientId === clientId)
      if (commandIndex >= 0) {
        const [{ command, resolveDelivery }] = this.commandQueue.splice(commandIndex, 1)
        this.commandHistory.push({
          ...command,
          clientId,
          deliveredAt: new Date().toISOString(),
        })
        resolveDelivery()
        json(response, 200, command)
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

  async handleModelResponse(request, response, protocol) {
    const body = await readRequestBody(request)
    const authorization = request.headers.authorization ?? null
    const modelRequest = { authorization, body, scenario: this.scenario }
    this.modelRequests.push(modelRequest)
    const authenticated =
      authorization === `Bearer ${MODEL_API_KEY}` || request.headers['x-api-key'] === MODEL_API_KEY
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
        const responseId = `vision-sidecar-main-${this.modelRequests.length}`
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(VISION_SIDECAR_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
        return
      }
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
        assertMcpNamespaceDeferred(body, 'node_repl')
        const search = selectToolSearch(body, 'Run JavaScript in the persistent Node REPL')
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchCall(NODE_REPL_TOOL_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 3) {
        assert.equal(
          requestContainsToolOutput(body, NODE_REPL_TOOL_SEARCH_ID),
          true,
          'The Node REPL tool search output did not return through the real Codex tool loop'
        )
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
        assertMcpNamespaceDeferred(body, 'github__issues')
        const search = selectToolSearch(body, 'Get deterministic GitHub issue details')
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchCall(GENERIC_MCP_TOOL_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 5) {
        assert.equal(
          requestContainsToolOutput(body, GENERIC_MCP_TOOL_SEARCH_ID),
          true,
          'The generic MCP tool search output did not return through the real Codex tool loop'
        )
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
        ...functionCall('wework-e2e-view-image', image.name, image.arguments),
        customToolCall('wework-e2e-apply-patch', 'apply_patch', patch),
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
        await this.initialCompletionRelease
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
      const tool = selectShellTool(body, this.cloudWorkspacePath)
      const patch = selectCloudApplyPatchTool(body)
      this.cloudModelStage = 'awaiting_tool_output'
      this.writeSse(response, [
        responseCreated(responseId),
        ...functionCall('wework-cloud-e2e-tool-call', tool.name, tool.arguments),
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
      this.cloudModelStage = 'complete'
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(CLOUD_COMPLETION_TEXT),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'cloud_follow_up') {
      this.recordScenarioRequest('cloud_follow_up', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(CLOUD_FOLLOW_UP_PROMPT),
        'The real cloud Codex request did not contain the follow-up prompt'
      )
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.write(createSse([responseCreated(responseId)]))
      await this.cloudFollowUpRelease
      response.end(
        createSse([
          assistantMessage(CLOUD_FOLLOW_UP_COMPLETION_TEXT),
          responseCompleted(responseId),
        ])
      )
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
            requestText.includes(skillPath),
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
        assertMcpNamespaceDeferred(body, OFFICIAL_PLUGIN_MCP_NAMESPACE)
        const search = selectToolSearch(body, OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION)
        this.writeSse(response, [
          responseCreated(responseId),
          ...toolSearchCall(OFFICIAL_PLUGIN_TOOL_SEARCH_ID, search),
          responseCompleted(responseId),
        ])
        return
      }

      if (requestNumber === 4) {
        assert.equal(
          requestContainsToolOutput(body, OFFICIAL_PLUGIN_TOOL_SEARCH_ID),
          true,
          'The official plugin MCP tool search output did not return through the real Codex tool loop'
        )
        const mcpTool = selectOfficialPluginMcpTool(body, {
          workspacePath: this.workspacePath,
          targetPath: '../outside.env',
          envName: 'OPENAI_API_KEY',
        })
        this.writeSse(response, [
          responseCreated(responseId),
          ...namespacedFunctionCall(
            OFFICIAL_PLUGIN_MCP_TOOL_ID,
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

    if (this.scenario === 'file_panel_anchor') {
      this.recordScenarioRequest('file_panel_anchor', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(FILE_PANEL_ANCHOR_PROMPT),
        'The file panel anchor prompt was lost'
      )
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(
          FILE_PANEL_ANCHOR_RESPONSE.replace('README.md:1', `${this.workspacePath}/README.md:1`)
        ),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'automation') {
      this.recordScenarioRequest('automation', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(AUTOMATION_PROMPT),
        'The automation prompt was lost before model execution'
      )
      const requestNumber = this.scenarioRequests.get('automation').length
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`${AUTOMATION_COMPLETION_TEXT}_${requestNumber}`),
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
      if (requestText.includes('Current visible progress snapshot (JSON):')) {
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
        this.writeSse(response, [
          responseCreated(responseId),
          assistantMessage(
            JSON.stringify({
              correction: SUPERVISOR_CORRECTION,
              rationale: 'The completed reply should restate the original constraint.',
            })
          ),
          responseCompleted(responseId),
        ])
        return
      }
      if (requestText.includes(SUPERVISOR_CORRECTION)) {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        this.resolveSupervisorCorrectionStarted()
        await this.supervisorCorrectionRelease
        response.end(
          createSse([
            assistantMessage(SUPERVISOR_CORRECTION_COMPLETION_TEXT),
            responseCompleted(responseId),
          ])
        )
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
      const requestText = JSON.stringify(body)
      const folderPath = join(this.workspacePath, PASTED_PATH_FOLDER_NAME)
      const filePath = join(this.workspacePath, PASTED_PATH_FILE_NAME)
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
      const requestText = JSON.stringify(body)
      const folderPath = join(this.workspacePath, DROPPED_PATH_FOLDER_NAME)
      const filePath = join(this.workspacePath, DROPPED_PATH_FILE_NAME)
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

    if (this.scenario === 'side_chat_queue') {
      this.recordScenarioRequest('side_chat_queue', modelRequest)
      const requestText = JSON.stringify(body)
      const requestCount = this.scenarioRequests.get('side_chat_queue')?.length ?? 0
      if (requestCount === 1) {
        assert.ok(
          requestText.includes(SIDE_CHAT_QUEUE_INITIAL),
          'The initial side-chat queue request lost its prompt'
        )
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        await this.sideChatQueueRelease
        if (response.destroyed || response.writableEnded) return
        response.end(createSse([responseCompleted(responseId)]))
        return
      }
      assert.ok(
        requestText.includes(SIDE_CHAT_QUEUE_FOLLOW_UP),
        'The queued side-chat follow-up lost its prompt'
      )
      this.writeSse(response, [responseCreated(responseId), responseCompleted(responseId)])
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

    if (this.scenario === 'queue_management') {
      this.recordScenarioRequest('queue_management', modelRequest)
      const latestInput = latestModelInputText(body)
      const initialPrompts = [QUEUE_DIRECT_INITIAL, QUEUE_PRESERVE_INITIAL, QUEUE_CLEAR_INITIAL]
      if (initialPrompts.some(prompt => latestInput.includes(prompt))) {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        })
        response.write(createSse([responseCreated(responseId)]))
        return
      }

      const followUpPrompts = [
        QUEUE_DIRECT_FIRST,
        QUEUE_DIRECT_SECOND,
        QUEUE_DIRECT_THIRD,
        QUEUE_PRESERVE_QUEUED,
        QUEUE_PRESERVE_MANUAL,
        QUEUE_CLEAR_MANUAL,
      ]
      const prompt = followUpPrompts.find(candidate => latestInput.includes(candidate))
      assert.ok(prompt, `Unexpected queue management request: ${latestInput}`)
      this.writeSse(response, [
        responseCreated(responseId),
        assistantMessage(`${QUEUE_MANAGEMENT_COMPLETION_PREFIX}:${prompt}`),
        responseCompleted(responseId),
      ])
      return
    }

    if (this.scenario === 'retry') {
      this.recordScenarioRequest('retry', modelRequest)
      assert.ok(
        JSON.stringify(body).includes(RETRY_PROMPT),
        'The real Codex request did not contain the retry prompt'
      )
      const retryRequests = this.scenarioRequests.get('retry') ?? []
      if (retryRequests.length === 1) {
        this.writeSse(response, [
          responseCreated(responseId),
          responseFailed(responseId, RETRY_FAILURE_TEXT),
        ])
        return
      }
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

    assert.ok(
      JSON.stringify(body).includes(PROVIDER_SWITCH_PROMPT),
      'The provider-switch request lost the user prompt'
    )
    this.recordScenarioRequest('provider_switch_retry', modelRequest)
    const promptRequestCount = this.scenarioRequests.get('provider_switch_retry').length
    if (promptRequestCount === 1) {
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
      this.assertLocalNamespaceTools(model, body)
      if (model.protocol !== 'responses') {
        state.stage = 'awaiting_namespace_tool_output'
        this.writeLocalNamespaceToolCall(response, model)
        return
      }
      state.stage = 'awaiting_tool_output'
      this.writeLocalToolCall(response, model, localProtocolPatch(model))
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
    if (model.protocol === 'responses') return
    const tools = Array.isArray(body.tools) ? body.tools : []
    const names = tools
      .map(candidate => candidate?.name ?? candidate?.function?.name)
      .filter(Boolean)

    assert.ok(
      names.includes('browser_snapshot'),
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
      serialized.includes('unsupported function call: browser_snapshot'),
      false,
      `${model.protocol} did not restore the wework_browser namespace on the tool call`
    )

    if (model.protocol === 'chat') {
      const call = body.messages
        ?.flatMap(message => message?.tool_calls ?? [])
        .find(candidate => candidate?.function?.name === 'browser_snapshot')
      assert.ok(call, 'Chat lost the flattened browser_snapshot call history')
      assert.ok(
        body.messages?.some(
          message => message?.role === 'tool' && message?.tool_call_id === call?.id
        ),
        'Chat lost the namespaced browser_snapshot result'
      )
      return
    }

    const blocks = body.messages?.flatMap(message => message?.content ?? []) ?? []
    const call = blocks.find(
      block => block?.type === 'tool_use' && block?.name === 'browser_snapshot'
    )
    assert.ok(call, 'Anthropic lost the flattened browser_snapshot call history')
    assert.ok(
      blocks.some(block => block?.type === 'tool_result' && block?.tool_use_id === call?.id),
      'Anthropic lost the namespaced browser_snapshot result'
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

  writeLocalNamespaceToolCall(response, model) {
    const callId = `${model.protocol}-local-browser-snapshot`
    if (model.protocol === 'chat') {
      this.writeChatToolCall(response, {}, callId, 'browser_snapshot')
      return
    }
    this.writeAnthropicToolCall(response, {}, callId, 'browser_snapshot')
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

async function writeCodexConfig(
  codexHome,
  modelServerUrl,
  scenarioConfigToml = '',
  upstreamApiFormat = 'openai-responses'
) {
  await mkdir(codexHome, { recursive: true })
  const configPath = join(codexHome, 'config.toml')
  const temporaryConfigPath = join(codexHome, `config.toml.${randomUUID()}.tmp`)
  await writeFile(
    temporaryConfigPath,
    `model_provider = "${MODEL_PROVIDER_ID}"\nmodel = "${DEFAULT_MODEL_ID}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n${scenarioConfigToml}\n[model_providers.${MODEL_PROVIDER_ID}]\nname = "Wework Desktop E2E"\nbase_url = "${modelServerUrl}/v1"\nenv_key = "WEWORK_E2E_MODEL_API_KEY"\nwire_api = "responses"\nupstream_api_format = "${upstreamApiFormat}"\n`,
    'utf8'
  )
  await rename(temporaryConfigPath, configPath)
}

function toolDetailsMcpConfigToml() {
  const command = JSON.stringify(process.execPath)
  const server = JSON.stringify(toolDetailsMcpServerPath)
  return [
    '[mcp_servers.node_repl]',
    `command = ${command}`,
    `args = [${server}, "node_repl"]`,
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers."github__issues"]',
    `command = ${command}`,
    `args = [${server}, "github__issues"]`,
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n')
}

function codexUpstreamApiFormat(protocol) {
  return protocol === 'responses'
    ? 'openai-responses'
    : protocol === 'chat'
      ? 'openai-chat-completions'
      : 'anthropic-messages'
}

async function buildExecutor() {
  const configured = process.env.WEWORK_E2E_EXECUTOR_BIN
  if (configured)
    return resolveExecutable(configured, 'wegent-executor', 'Configured Wework executor')

  await runChecked('cargo', ['build', '--locked', '--bin', 'wegent-executor'], {
    cwd: join(repoDir, 'executor'),
  })
  const binaryName = process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
  const binaryPath = join(repoDir, 'executor', 'target', 'debug', binaryName)
  assert.equal(await isExecutable(binaryPath), true, `Executor build did not produce ${binaryPath}`)
  return binaryPath
}

function hostCodexTarget() {
  const targetByPlatformAndArch = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'win32:x64': 'x86_64-pc-windows-msvc',
  }
  const target = targetByPlatformAndArch[`${process.platform}:${process.arch}`]
  assert.ok(target, `Unsupported Codex E2E host: ${process.platform}/${process.arch}`)
  return target
}

async function resolveDesktopCodexBinary() {
  const configured = process.env.WEWORK_E2E_CODEX_BIN || process.env.CODEX_BIN
  if (configured) {
    return resolveExecutable(configured, 'codex', 'Configured Wework E2E Codex')
  }

  const target = hostCodexTarget()
  await runChecked('pnpm', ['run', 'prepare:codex', '--target', target], {
    cwd: weworkDir,
  })
  const lock = JSON.parse(await readFile(join(weworkDir, 'codex-binaries.lock.json'), 'utf8'))
  const binaryRelativePath = lock.targets?.[target]?.binaryPath
  assert.equal(typeof binaryRelativePath, 'string', `Codex lock is missing target ${target}`)
  return resolveExecutable(
    join(weworkDir, 'src-tauri', 'binaries', 'codex', target, binaryRelativePath),
    'codex',
    'Repository Codex'
  )
}

async function readTauriMainBinaryName() {
  const configPath = join(weworkDir, 'src-tauri', 'tauri.conf.json')
  try {
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    return config.mainBinaryName || 'app'
  } catch {
    return 'app'
  }
}

async function readTauriE2EWindowConfig() {
  const configPath = join(weworkDir, 'src-tauri', 'tauri.conf.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const windows = config.app?.windows
  assert.ok(Array.isArray(windows) && windows.length > 0, 'Tauri main window config is missing')
  return windows.map(windowConfig => ({
    ...windowConfig,
    backgroundThrottling: 'disabled',
  }))
}

function macCodexBundleLayout() {
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  return {
    binaryRelativePath: join('vendor', target, 'bin', 'codex'),
    target,
  }
}

function findCodexPackageRoot(codexBinary, binaryRelativePath) {
  const parts = binaryRelativePath.split('/')
  let packageRoot = codexBinary
  for (const _part of parts) packageRoot = dirname(packageRoot)
  return resolve(packageRoot, binaryRelativePath) === resolve(codexBinary) ? packageRoot : null
}

async function bundleMacCodex(contentsPath, codexBinary) {
  const { binaryRelativePath, target } = macCodexBundleLayout()
  const bundledPackageRoot = join(contentsPath, 'Resources', 'binaries', 'codex', target)
  const bundledCodexBinary = join(bundledPackageRoot, binaryRelativePath)
  const packageRoot = findCodexPackageRoot(codexBinary, binaryRelativePath)

  await mkdir(dirname(bundledPackageRoot), { recursive: true })
  if (packageRoot) {
    await symlink(packageRoot, bundledPackageRoot, 'dir')
  } else {
    await mkdir(dirname(bundledCodexBinary), { recursive: true })
    await copyFile(codexBinary, bundledCodexBinary)
    await chmod(bundledCodexBinary, 0o755)
  }

  assert.equal(
    await isExecutable(bundledCodexBinary),
    true,
    `The isolated macOS app did not contain an executable Codex at ${bundledCodexBinary}`
  )
  console.log(`Bundled E2E Codex: ${bundledCodexBinary}`)
  return bundledCodexBinary
}

async function wrapMacDesktopApp(binaryPath, binaryName, appIdentifier, codexBinary) {
  if (process.platform !== 'darwin') {
    return { binaryPath, appBundlePath: null, codexBinaryPath: null }
  }

  const appBundlePath = join(resultDir, `WeWork-E2E-${process.pid}.app`)
  const contentsPath = join(appBundlePath, 'Contents')
  const bundledBinaryPath = join(contentsPath, 'MacOS', binaryName)
  await mkdir(join(contentsPath, 'MacOS'), { recursive: true })
  await copyFile(binaryPath, bundledBinaryPath)
  await chmod(bundledBinaryPath, 0o755)
  await writeFile(
    join(contentsPath, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${binaryName}</string>
  <key>CFBundleIdentifier</key><string>${appIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>WeWork E2E ${process.pid}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
    `,
    'utf8'
  )
  const bundledCodexBinary = await bundleMacCodex(contentsPath, codexBinary)
  commandOutput(MACOS_LAUNCH_SERVICES_REGISTER, ['-f', appBundlePath])
  return {
    binaryPath: bundledBinaryPath,
    appBundlePath,
    codexBinaryPath: bundledCodexBinary,
  }
}

async function buildDesktopApp(
  controlUrl,
  cloudBackendUrl,
  cloudToken,
  appIdentifier,
  modelServerUrl,
  codexBinary
) {
  const configured = process.env.WEWORK_E2E_APP_BIN
  if (configured) {
    const binaryPath = await resolveExecutable(configured, 'app', 'Configured Wework desktop app')
    return wrapMacDesktopApp(binaryPath, binaryPath.split('/').at(-1), appIdentifier, codexBinary)
  }

  const windows = (await readTauriE2EWindowConfig()).map(window => ({
    ...window,
    backgroundThrottling: 'disabled',
    focus: false,
  }))
  await runChecked(
    'pnpm',
    [
      'exec',
      'tauri',
      'build',
      '--debug',
      '--no-bundle',
      '--config',
      JSON.stringify({
        identifier: appIdentifier,
        app: {
          windows,
          security: {
            capabilities: [
              'default',
              'workspace-window',
              {
                identifier: 'desktop-e2e-window',
                description: 'Allows the desktop E2E runner to manage test window visibility',
                windows: ['main'],
                permissions: ['core:window:allow-show', 'core:window:allow-unminimize'],
              },
            ],
          },
        },
      }),
    ],
    {
      cwd: weworkDir,
      env: {
        ...process.env,
        VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: controlUrl,
        VITE_WEWORK_E2E_CLOUD_BACKEND_URL: cloudBackendUrl,
        VITE_WEWORK_E2E_CLOUD_TOKEN: cloudToken,
        VITE_WEWORK_E2E_MODEL_SERVER_URL: modelServerUrl,
        VITE_WEWORK_E2E_LOCAL_MODELS_CATALOG_READY: CLOUD_ONLY ? 'true' : 'false',
        VITE_WEWORK_E2E: 'true',
        VITE_WEWORK_E2E_TRANSCRIPT_PAGE_SIZE: '49',
        VITE_WEWORK_E2E_CODEX_HOME_INITIALIZATION: RUNS_PLUGIN_E2E ? 'true' : 'false',
        VITE_WEWORK_E2E_SEED_LOCAL_MODELS: RUNS_PLUGIN_E2E || MEMORY_ONLY ? 'false' : 'true',
        VITE_WEWORK_POSTHOG_HOST: modelServerUrl,
        VITE_WEWORK_POSTHOG_KEY: TELEMETRY_TEST_PROJECT_KEY,
        VITE_WEWORK_RELEASE_CHANNEL: 'stable',
        VITE_WEWORK_RUNTIME_MODE: 'local-first',
      },
    }
  )
  const mainBinaryName = await readTauriMainBinaryName()
  const binaryName = process.platform === 'win32' ? `${mainBinaryName}.exe` : mainBinaryName
  const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim()
  const candidates = [
    ...(cargoTargetDir ? [join(cargoTargetDir, 'debug', binaryName)] : []),
    join(weworkDir, 'src-tauri', 'target', 'debug', binaryName),
    join(
      weworkDir,
      'src-tauri',
      'target',
      'debug',
      'bundle',
      'macos',
      'WeWork.app',
      'Contents',
      'MacOS',
      binaryName
    ),
  ]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return wrapMacDesktopApp(candidate, binaryName, appIdentifier, codexBinary)
    }
  }
  throw new Error(
    `Tauri build did not produce an executable app. Checked: ${candidates.join(', ')}`
  )
}

async function verifyConnectedModelsOnLocalExecution({
  control,
  cloudEnvironment,
  setCodexUpstreamProtocol,
  workspacePath,
}) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-local-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForFolderPickerInitialized(control)
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await confirmLocalProjectName(control, 'workspace')
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const projectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project was not shown in the sidebar'
  )
  const projectMenuTestId = projectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(projectMenuTestId, 'The local matrix project did not expose its project menu')
  const projectId = projectMenuTestId.slice('project-menu-'.length)
  const newConversationSelector = `[data-testid="project-row-${projectId}"] [data-testid="project-new-conversation-button"]`

  await verifyModelProtocolMatrix({
    cases: LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector,
    screenshotPrefix: 'local-connected-matrix',
    setCodexUpstreamProtocol,
    startIndex: LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES.length,
    workspacePath,
  })

  await verifyVisionSidecar({
    composerSelector,
    control,
    modelCase: CLOUD_VISION_SIDECAR_CASE,
    projectRowSelector: newConversationSelector.replace(
      ' [data-testid="project-new-conversation-button"]',
      ''
    ),
  })

  const currentProjectSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project was not shown before removal'
  )
  const currentProjectMenuTestId = currentProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(currentProjectMenuTestId, 'The local matrix project did not expose its project menu')
  const currentProjectId = currentProjectMenuTestId.slice('project-menu-'.length)
  await control.command('click', `[data-testid="${currentProjectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${currentProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${currentProjectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.some(testId => testId.startsWith('project-menu-')),
    'The local matrix project remained visible after removal'
  )
}

async function verifyCloudProjectFlow(control, cloudEnvironment, restartDesktopApp, workspacePath) {
  const composerSelector = ACTIVE_COMPOSER_SELECTOR
  await control.command('waitFor', '[data-testid="projects-create-button"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const remoteDialogSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('standalone-remote-device-select') ||
      snapshot.testIds.includes('refresh-remote-devices-button'),
    'The remote device dialog exposed neither a connected device nor its refresh action'
  )
  if (!remoteDialogSnapshot.testIds.includes('standalone-remote-device-select')) {
    await control.command('clickIfPresent', '[data-testid="refresh-remote-devices-button"]')
  }
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The remote folder picker did not load the real executor home directory'
  )
  await captureVerificationScreenshot(control, 'cloud-01-remote-device-selected.png')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    workspacePath,
    'The remote folder picker did not retain the selected cloud workspace path'
  )
  await captureVerificationScreenshot(control, 'cloud-02-workspace-path-confirmed.png')
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('standalone-folder-project-dialog') &&
      value.testIds.some(testId => testId.startsWith('project-device-status-')),
    'The real cloud project was not shown with its remote device status'
  )
  await control.command('waitFor', '[data-testid^="project-menu-"]', {
    stableMs: COMPOSER_READY_STABILITY_MS * 2,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const projectSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const projectMenuTestIds = projectSnapshot.testIds.filter(testId =>
    testId.startsWith('project-menu-')
  )
  assert.equal(
    projectMenuTestIds.length,
    1,
    'The cloud flow did not expose exactly one remote project'
  )
  await captureVerificationScreenshot(control, 'cloud-03-project-created.png')
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="sidebar-cloud-connection-button"]', {
    text: '云端工作',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-work-01-plugin-entry.png')
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', '[data-testid="cloud-work-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('waitFor', `[data-testid="connection-device-${CLOUD_DEVICE_ID}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const cloudWorkSnapshot = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.some(testId => testId.startsWith('cloud-work-project-')),
    'The cloud work page did not show the created cloud project'
  )
  const cloudWorkProjectTestId = cloudWorkSnapshot.testIds.find(testId =>
    testId.startsWith('cloud-work-project-')
  )
  assert.ok(cloudWorkProjectTestId, 'The cloud work page did not expose a project row')
  assert.equal(
    cloudWorkSnapshot.testIds.includes('general-settings-page'),
    false,
    'Clicking Cloud work from Plugins unexpectedly opened general settings'
  )
  await control.command('waitFor', `[data-testid="connection-device-metrics-${CLOUD_DEVICE_ID}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`)
  await control.command('waitFor', `[data-testid="connection-more-menu-${CLOUD_DEVICE_ID}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-work-02-device-and-project.png')
  await control.command('click', `[data-testid="connection-more-button-${CLOUD_DEVICE_ID}"]`)
  await control.command('click', `[data-testid="${cloudWorkProjectTestId}"]`)
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-work-03-project-opened.png')
  await control.command(
    'clickWhenEnabled',
    '[data-testid^="project-row-"] [data-testid="project-new-conversation-button"]'
  )
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'workspace',
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-04-conversation-ready.png')
  await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
  await openBottomWorkspaceTerminal(control, 'The new cloud task')
  await captureVerificationScreenshot(control, 'cloud-04b-new-task-terminal-open.png')
  await control.command('click', '[data-testid="close-bottom-workspace-tab-button"]')
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes('workspace-tool-launcher') &&
      !value.testIds.includes('workspace-terminal-window'),
    'The new cloud task terminal and bottom panel did not close cleanly',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )

  control.setScenario('cloud_initial')
  await sendPrompt(control, composerSelector, CLOUD_TASK_PROMPT)
  const cloudInitialRequest = await withTimeout(
    control.awaitScenarioRequestCount('cloud_initial', 2),
    DEFAULT_STEP_TIMEOUT_MS,
    'The real cloud executor did not complete its model tool loop'
  )
  assert.equal(
    cloudInitialRequest.body?.model,
    DEFAULT_MODEL_ID,
    'The remote executor did not receive the selected canonical model id'
  )
  assert.equal(
    (await readFile(join(workspacePath, CLOUD_ARTIFACT_NAME), 'utf8')).trim(),
    CLOUD_ARTIFACT_CONTENT,
    'The real cloud executor did not create the verification artifact'
  )
  const taskRowTestId = await waitForTaskRowByText(control, 'WEWORK_DESKTOP_E2E_CLOUD_TASK')
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await captureVerificationScreenshot(control, 'cloud-05-initial-task-completed.png')

  await openBottomWorkspaceTerminal(control, 'The historical cloud task')
  await closeBottomWorkspacePanel(control)
  await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes('workspace-terminal-window') &&
      value.testIds.includes('remote-terminal') &&
      !value.testIds.includes('workspace-tool-launcher'),
    'The historical cloud task did not restore its existing terminal',
    DEFAULT_STEP_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command('click', '[data-testid="workspace-terminal-new-tab-button"]')
  const addMenuSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.includes('workspace-terminal-new-tab-menu'),
    'The bottom workspace add menu did not open'
  )
  assert.ok(addMenuSnapshot.testIds.includes('workspace-add-terminal-option'))
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-ide-option'),
    false,
    'The bottom workspace add menu exposed IDE'
  )
  assert.equal(
    addMenuSnapshot.testIds.includes('workspace-add-desktop-option'),
    false,
    'The external build exposed the internal desktop extension'
  )
  await control.command('press', 'body', { key: 'Escape' })
  await captureVerificationScreenshot(control, 'cloud-05b-historical-terminal-restored.png')
  await closeBottomWorkspacePanel(control)

  control.setScenario('cloud_follow_up')
  const runningTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-running-'
  )
  const unreadTaskTestId = taskRowTestId.replace(
    'runtime-local-task-row-',
    'runtime-local-task-unread-dot-'
  )
  await sendPrompt(control, composerSelector, CLOUD_FOLLOW_UP_PROMPT)
  await withTimeout(
    control.awaitScenarioRequest('cloud_follow_up'),
    DEFAULT_STEP_TIMEOUT_MS,
    'The real cloud executor did not send the follow-up model request'
  )
  await waitForSnapshot(
    control,
    value =>
      value.testIds.includes(runningTaskTestId) &&
      value.testIds.includes('pause-response-button') &&
      value.testIds.includes('thinking-indicator') &&
      !value.testIds.includes('send-message-button') &&
      !value.testIds.includes(unreadTaskTestId),
    'The cloud follow-up task did not render a consistent sidebar, composer, and message state',
    DEFAULT_STEP_TIMEOUT_MS
  )
  control.releaseCloudFollowUpResponse()
  await control.command('click', `[data-testid="${taskRowTestId}"]`)
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: CLOUD_FOLLOW_UP_COMPLETION_TEXT,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    value => !value.testIds.includes(runningTaskTestId),
    'The cloud follow-up task did not settle before project removal'
  )
  await captureVerificationScreenshot(control, 'cloud-06-follow-up-completed.png')

  await verifyAnthropicEmptyResponseRecovery({ composerSelector, control })

  await verifyModelProtocolMatrix({
    cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
    composerSelector,
    control,
    newConversationSelector:
      '[data-testid^="project-row-"] [data-testid="project-new-conversation-button"]',
    screenshotPrefix: 'cloud-matrix',
    setCodexUpstreamProtocol: protocol => cloudEnvironment.setCodexUpstreamProtocol(protocol),
    startIndex: LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES.length,
    workspacePath,
  })

  const currentProjectSnapshot = await waitForSnapshot(
    control,
    value => value.testIds.some(testId => testId.startsWith('project-menu-')),
    'The cloud project was not shown in the sidebar'
  )
  const currentProjectMenuTestId = currentProjectSnapshot.testIds.find(testId =>
    testId.startsWith('project-menu-')
  )
  assert.ok(currentProjectMenuTestId, 'The cloud project did not expose its project menu')
  const currentProjectId = currentProjectMenuTestId.slice('project-menu-'.length)
  const projectMenuTestId = `project-menu-${currentProjectId}`
  await control.command('click', `[data-testid="${projectMenuTestId}"]`)
  await control.command('click', `[data-testid="remove-project-${currentProjectId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="remove-project-dialog-${currentProjectId}-confirm-button"]`
  )
  await cloudEnvironment.waitForWorkspaceRemoved(workspacePath)
  await waitForSnapshot(
    control,
    value =>
      !value.testIds.includes(projectMenuTestId) &&
      !value.testIds.includes(`remove-project-dialog-${currentProjectId}`),
    'The removed cloud project remained visible in the workbench'
  )
  await captureVerificationScreenshot(control, 'cloud-07-project-removed.png')

  await control.command('click', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('waitFor', '[data-testid="standalone-remote-device-select"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await waitForControlValue(
    control,
    '[data-testid="device-folder-path-input"]',
    join(resultDir, 'cloud-executor-home'),
    'The duplicate regression remote picker did not load the cloud executor home'
  )
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await waitForFolderPathReady(control, workspacePath)
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]')
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.filter(testId => testId.startsWith('project-menu-')).length === 1,
    'The duplicate regression cloud project was not created'
  )

  await cloudEnvironment.aliasCloudDeviceToCurrentApp()
  await createSingleRootLocalProject(control, workspacePath, 'workspace')
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.filter(testId => testId.startsWith('project-menu-')).length === 1,
    'Creating a local project while cloud work was connected exposed duplicate projects',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'cloud-08-local-project-deduplicated.png')

  await restartDesktopApp()
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.filter(testId => testId.startsWith('project-menu-')).length === 1,
    'Restarting Wework changed the deduplicated local and cloud project into multiple rows',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await captureVerificationScreenshot(control, 'cloud-09-local-project-deduplicated-restart.png')
}

async function verifyRetryFailureRestoration(control, composerSelector) {
  control.setScenario('retry')
  await sendPromptUntilScenarioRequest(control, composerSelector, RETRY_PROMPT, 'retry')
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  const retryDebugSnapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const retryTaskId = retryDebugSnapshot.workbench?.currentRuntimeTask?.taskId
  assert.ok(retryTaskId, 'The failed retry task did not expose its runtime task ID')
  const retryTaskRowTestId = `runtime-local-task-row-${retryTaskId}`
  await control.command('waitFor', `[data-testid="${retryTaskRowTestId}"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${retryTaskRowTestId}"]`)
  await waitForWorkbenchTask(
    control,
    retryTaskId,
    'The failed retry task did not become active again'
  )
  await control.command(
    'clickIfPresent',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-details-toggle"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-card"]`,
    {
      text: RETRY_CODEX_ERROR_TEXT,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  await captureVerificationScreenshot(
    control,
    'retry-01-failure-restored-after-switch.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  await control.command(
    'click',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-error-retry"]`
  )
  await waitForScenarioRequestCount(control, 'retry', 2)
  control.releaseRetryResponse()
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: RETRY_COMPLETION_TEXT,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  let successfulRetrySnapshot = JSON.parse(
    await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
  )
  assert.equal(
    successfulRetrySnapshot.testIds.includes('assistant-error-card'),
    false,
    'The failed attempt card remained after retry succeeded'
  )
  assert.equal(
    successfulRetrySnapshot.testIds.filter(testId => testId === 'message-assistant').length,
    1,
    'Retry success left an empty assistant turn in the live conversation'
  )

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('click', `[data-testid="${retryTaskRowTestId}"]`)
  await waitForWorkbenchTask(
    control,
    retryTaskId,
    'The successful retry task did not become active again'
  )
  await control.command(
    'clickIfPresent',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="scroll-to-bottom-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    {
      text: RETRY_COMPLETION_TEXT,
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    }
  )
  successfulRetrySnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  assert.equal(
    successfulRetrySnapshot.testIds.includes('assistant-error-card'),
    false,
    'A cached failure card returned after reopening the successfully retried conversation'
  )
  assert.equal(
    successfulRetrySnapshot.testIds.filter(testId => testId === 'message-assistant').length,
    1,
    'Reopening a successful retry restored an empty failed assistant turn'
  )
  await captureVerificationScreenshot(
    control,
    'retry-02-success-restored-without-failed-turn.png',
    ACTIVE_WORKBENCH_SELECTOR
  )
  assert.equal(
    control.scenarioRequests.get('retry')?.length,
    2,
    'Retry did not issue exactly one additional request for the failed user message'
  )
}

async function verifyModelProtocolMatrix({
  cases,
  composerSelector,
  control,
  newConversationSelector,
  screenshotPrefix,
  setCodexUpstreamProtocol,
  startIndex = 0,
  workspacePath,
}) {
  let hasConfirmedCatalogSync = false
  for (const [caseIndex, model] of cases.entries()) {
    const matrixIndex = startIndex + caseIndex
    console.log(
      `Model protocol matrix ${matrixIndex + 1}/${MODEL_PROTOCOL_MATRIX_TOTAL} started: ${matrixCaseId(model)}`
    )
    if (model.source === 'codex') {
      assert.ok(
        setCodexUpstreamProtocol,
        `${matrixCaseId(model)} requires a Codex upstream protocol setter`
      )
      await setCodexUpstreamProtocol(model.protocol)
    }
    control.setMatrixCase(model)
    await control.command('clickWhenEnabled', newConversationSelector)
    await control.command('waitFor', composerSelector, {
      stableMs: COMPOSER_READY_STABILITY_MS,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await selectE2EModel(control, model.optionId, model.label)

    const confirmCloudModelCatalogSync =
      !hasConfirmedCatalogSync && model.execution === 'cloud' && model.source === 'local'
    await sendPromptWithButton(
      control,
      composerSelector,
      matrixTextPrompt(model),
      MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
      {
        confirmCloudModelCatalogSync,
      }
    )
    if (confirmCloudModelCatalogSync) {
      hasConfirmedCatalogSync = true
    }
    await waitForMatrixStage(control, model, 'tool')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: matrixTextCompletion(model),
      timeoutMs: MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
    })

    await sendPromptWithButton(control, composerSelector, matrixToolPrompt(model))
    await waitForMatrixStage(control, model, 'awaiting_tool_output', 'complete')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: matrixToolCompletion(model),
      timeoutMs: MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
    })
    assert.equal(
      (await readFile(join(workspacePath, matrixArtifact(model)), 'utf8')).trim(),
      matrixArtifactContent(model),
      `${matrixCaseId(model)} apply_patch did not create the expected artifact`
    )
    assert.equal(
      control.matrixState?.stage,
      'complete',
      `${matrixCaseId(model)} did not complete text and tool turns`
    )
    assert.ok(
      control.matrixState.requests.length >= 3,
      `${matrixCaseId(model)} did not send the text/tool/tool-output request sequence`
    )
    await prepareCompletedTurnScreenshot(control)
    await captureVerificationScreenshot(
      control,
      `${screenshotPrefix}-${String(matrixIndex + 1).padStart(2, '0')}-${matrixCaseId(model)}.png`
    )
    console.log(`Model protocol matrix passed: ${matrixCaseId(model)}`)
  }
}

async function waitForMatrixStage(control, model, ...expectedStages) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < MODEL_PROTOCOL_MATRIX_TIMEOUT_MS) {
    if (control.fatalError) throw control.fatalError
    if (expectedStages.includes(control.matrixState?.stage)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(
    `${matrixCaseId(model)} did not reach ${expectedStages.join(' or ')} within ${MODEL_PROTOCOL_MATRIX_TIMEOUT_MS}ms; current stage=${control.matrixState?.stage ?? 'missing'}`
  )
}

async function main() {
  validateDesktopSegmentOptions()
  await mkdir(resultDir, { recursive: true })
  console.log(`[desktop-e2e] result directory: ${resultDir}`)
  const workspacePath = join(resultDir, 'workspace')
  const secondaryProjectPath = join(resultDir, 'secondary-project-root')
  const composerProjectPath = join(resultDir, 'composer-project')
  const homePath = join(resultDir, 'home')
  const executorHome = join(resultDir, 'executor-home')
  const codexHome = join(executorHome, 'codex')
  const nativeCodexHome = join(resultDir, 'native-codex')
  const pluginMarketplacePath = join(resultDir, 'plugin-marketplace')
  const marketplacePluginPath = join(resultDir, 'marketplace-plugin')
  const officialPluginRepositoryPath = join(resultDir, 'openai-plugins')
  const appLogPath = join(resultDir, 'app.log')
  const executorLogPath = join(resultDir, 'executor.log')
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(secondaryProjectPath, { recursive: true }),
    mkdir(composerProjectPath, { recursive: true }),
    mkdir(homePath, { recursive: true }),
  ])
  await writeFile(join(workspacePath, GIT_SEED_NAME), GIT_SEED_CONTENT)
  await writeFile(join(workspacePath, 'auth.ts'), 'export const authenticated = true\n')
  await writeFile(
    join(workspacePath, IMAGE_ARTIFACT_NAME),
    Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
  )
  if (RUNS_PLUGIN_E2E) {
    assert.equal(
      await pathExists(join(codexHome, 'config.toml')),
      false,
      'The isolated Wework Codex home was not blank before application startup'
    )
    await createOfficialPluginMarketplaceFixture({
      marketplaceRoot: pluginMarketplacePath,
      repositoryRoot: officialPluginRepositoryPath,
    })
    await createPluginMarketplaceFixture(marketplacePluginPath)
    await mkdir(nativeCodexHome, { recursive: true })
    await writeFile(
      join(nativeCodexHome, 'config.toml'),
      '# desktop-e2e-native-home-marker\nmodel = "native-model-that-must-not-migrate"\n'
    )
  }
  await runChecked('git', ['init'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.name', 'Wework Desktop E2E'], { cwd: workspacePath })
  await runChecked('git', ['config', 'user.email', 'desktop-e2e@wework.local'], {
    cwd: workspacePath,
  })
  await runChecked('git', ['add', GIT_SEED_NAME, 'auth.ts', IMAGE_ARTIFACT_NAME], {
    cwd: workspacePath,
  })
  await runChecked('git', ['commit', '-m', 'test: initialize desktop e2e workspace'], {
    cwd: workspacePath,
  })

  const desktopScenario = await loadDesktopScenario(
    process.env.WEWORK_E2E_DESKTOP_SCENARIO_MODULE,
    {
      captureScreenshot: (control, name, selector) =>
        captureVerificationScreenshot(control, name, selector),
      executorHome,
      resultDir,
      standalone: DESKTOP_SCENARIO_ONLY,
      uiTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      workspacePath,
    }
  )
  if (DESKTOP_SCENARIO_ONLY && !desktopScenario) {
    throw new Error('Desktop scenario-only mode requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE')
  }
  const control = new DesktopE2EServer(workspacePath, workspacePath, desktopScenario)
  const modelSwitchVerification = []
  let app
  let appBundlePath
  let blockingNetworkProxy
  let cloudEnvironment
  let phase = 'startup'
  let desktopScenarioVerified = false
  try {
    await control.start()
    if (RUNS_PLUGIN_E2E) {
      blockingNetworkProxy = new BlockingNetworkProxy()
      await blockingNetworkProxy.start()
    }
    const codexBinary = await resolveDesktopCodexBinary()
    const codexVersion = commandOutput(codexBinary, ['--version'])
    assert.ok(codexVersion.length > 0, 'Real Codex did not return a version')
    console.log(`Using real Codex: ${codexVersion}`)
    const appIdentifier = `io.wecode.wework.e2e.run${process.pid}`
    const executorBinary = await buildExecutor()
    if (CLOUD_ONLY) {
      cloudEnvironment = new RealCloudEnvironment({
        codexBinary,
        executorBinary,
        modelServerUrl: control.url,
        workspacePath,
      })
      await cloudEnvironment.start()
    }
    const desktopApp = await buildDesktopApp(
      control.controlUrl,
      cloudEnvironment?.backendUrl ?? control.url,
      cloudEnvironment?.authToken ?? desktopScenario?.authToken ?? 'wework-desktop-e2e-cloud-token',
      appIdentifier,
      control.url,
      codexBinary
    )
    const appBinary = desktopApp.binaryPath
    appBundlePath = desktopApp.appBundlePath
    const resolvedAppCodexBinary = desktopApp.codexBinaryPath ?? codexBinary
    const buildManifestPath = process.env.WEWORK_E2E_BUILD_MANIFEST
    if (buildManifestPath) {
      await mkdir(dirname(buildManifestPath), { recursive: true })
      await writeFile(
        buildManifestPath,
        `${JSON.stringify(
          {
            appBinary,
            controlServerPort: DESKTOP_CONTROL_SERVER_PORT,
            executorBinary,
            modelServerPort: DESKTOP_MODEL_SERVER_PORT,
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    }
    if (BUILD_ONLY) {
      console.log(`Wework desktop E2E build passed. Manifest: ${buildManifestPath}`)
      return
    }
    if (!RUNS_PLUGIN_E2E) {
      await writeCodexConfig(
        codexHome,
        control.url,
        `${desktopScenario?.codexConfigToml ?? ''}\n${
          shouldConfigureToolDetailsMcp() ? toolDetailsMcpConfigToml() : ''
        }`
      )
    }

    const appEnvironment = {
      ...process.env,
      CODEX_BINARY_PATH: resolvedAppCodexBinary,
      CODEX_BIN: resolvedAppCodexBinary,
      HOME: homePath,
      WEGENT_CODEX_HOME: codexHome,
      WEGENT_EXECUTOR_HOME: executorHome,
      WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'false',
      WEGENT_EXECUTOR_LOG_DIR: resultDir,
      WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
      DEVICE_ID: `wework-e2e-device-${process.pid}`,
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
      VITE_WEWORK_E2E: 'true',
      WEWORK_E2E_BACKGROUND_WINDOW: '1',
      WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
      WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR: '127.0.0.1:0',
      WEWORK_EXECUTOR_SIDECAR: executorBinary,
      ...(RUNS_PLUGIN_E2E
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: blockingNetworkProxy.url,
            WEWORK_E2E_NATIVE_CODEX_HOME: nativeCodexHome,
          }
        : {}),
    }
    const startDesktopAppProcess = async () => {
      if (process.platform === 'darwin') {
        assert.ok(appBundlePath, 'The macOS desktop E2E application bundle is missing')
        const environmentArgs = [
          'CODEX_BINARY_PATH',
          'CODEX_BIN',
          'HOME',
          'WEGENT_CODEX_HOME',
          'WEGENT_EXECUTOR_HOME',
          'WEWORK_EXECUTOR_ISOLATION_OVERRIDE',
          'WEGENT_EXECUTOR_LOG_DIR',
          'WEGENT_EXECUTOR_LOG_FILE',
          'DEVICE_ID',
          'DEVICE_SESSION_GATEWAY_HOST',
          'DEVICE_SESSION_GATEWAY_PORT',
          'VITE_WEWORK_E2E',
          'WEWORK_E2E_BACKGROUND_WINDOW',
          'WEWORK_E2E_MODEL_API_KEY',
          'WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR',
          'WEWORK_EXECUTOR_SIDECAR',
          ...(RUNS_PLUGIN_E2E
            ? [
                'GIT_CONFIG_COUNT',
                'GIT_CONFIG_KEY_0',
                'GIT_CONFIG_VALUE_0',
                'WEWORK_E2E_NATIVE_CODEX_HOME',
              ]
            : []),
        ].flatMap(key => ['--env', `${key}=${appEnvironment[key]}`])
        const launcher = spawn(
          'open',
          [
            '-W',
            '-n',
            '-g',
            ...environmentArgs,
            '--stdout',
            appLogPath,
            '--stderr',
            appLogPath,
            appBundlePath,
          ],
          {
            cwd: weworkDir,
            env: appEnvironment,
            stdio: 'ignore',
            detached: true,
          }
        )
        const pid = await waitForMacosApplicationProcessId(appIdentifier, launcher)
        return { launcher, pid }
      }

      const child = spawn(appBinary, [], {
        cwd: weworkDir,
        env: appEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      await Promise.all([
        appendProcessOutput(child.stdout, appLogPath),
        appendProcessOutput(child.stderr, appLogPath),
      ])
      return child
    }
    app = await startDesktopAppProcess()
    const restartDesktopApp = async (options = null) => {
      const beforeStart = typeof options === 'function' ? options : options?.afterStop
      const readyCountBeforeRestart = control.readyCount
      await stopDesktopAppProcess(app)
      await beforeStart?.()
      app = await startDesktopAppProcess()
      await withTimeout(
        control.awaitReadyAfter(readyCountBeforeRestart),
        WORKBENCH_READY_TIMEOUT_MS,
        'The restarted Wework application did not reconnect to the desktop controller'
      )
    }

    const ready = await withTimeout(
      control.awaitReady(),
      DESKTOP_READY_TIMEOUT_MS,
      'Timed out waiting for the real Tauri application to connect to the Desktop E2E controller'
    )
    assert.match(
      String(ready.location ?? ''),
      /^(tauri|http):/,
      'The desktop controller did not connect from a webview'
    )
    if (VERIFIES_INITIAL_TELEMETRY_CONSENT) {
      await verifyInitialTelemetryConsent(control, [
        workspacePath,
        homePath,
        cloudEnvironment?.authToken,
        desktopScenario?.authToken,
        MODEL_API_KEY,
        'desktop-e2e@wework.local',
      ])
    } else {
      await declineInitialTelemetryConsent(control)
    }
    if (process.platform === 'darwin') {
      assert.notEqual(
        macosFrontmostProcessId(),
        app.pid,
        'The desktop E2E application stole macOS foreground focus'
      )
    }
    if (RUNS_PLUGIN_E2E) {
      phase = 'blank-codex-home-initialization'
      await initializeBlankCodexHome({
        codexHome,
        control,
      })
      await writeCodexConfig(
        codexHome,
        control.url,
        `[features]
plugins = true

[marketplaces.${STARTUP_NETWORK_PROBE_MARKETPLACE_NAME}]
source_type = "git"
source = "${STARTUP_NETWORK_PROBE_MARKETPLACE_URL}"
last_updated = "2026-07-30T00:00:00Z"`
      )
      await verifyStartupIgnoresBlockedCodexNetwork({
        blockingNetworkProxy,
        control,
        restartDesktopApp,
      })
      await waitForBundledMarketplaceRegistration(codexHome)
    }
    if (SYSTEM_DRAG_PANEL_ONLY) {
      phase = 'system-drag-panel-layout'
      await verifySystemDragPanelLayout(control)
      console.log(`Wework desktop system-drag-panel E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (desktopScenario && DESKTOP_SCENARIO_ONLY) {
      phase = 'desktop-extension-scenario'
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop extension scenario E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (CLOUD_ONLY) {
      phase = 'server-downlinked-socket-url'
      await verifyLocalExecutorUsesCloudSocketUrl(control, cloudEnvironment)
      phase = 'local-connected-model-protocol-matrix'
      await verifyConnectedModelsOnLocalExecution({
        control,
        cloudEnvironment,
        setCodexUpstreamProtocol: protocol =>
          writeCodexConfig(
            join(executorHome, 'codex'),
            control.url,
            '',
            codexUpstreamApiFormat(protocol)
          ),
        workspacePath,
      })
      phase = 'cloud-project-flow'
      await verifyCloudProjectFlow(control, cloudEnvironment, restartDesktopApp, workspacePath)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop cloud-project E2E passed. Diagnostics: ${resultDir}`)
      return
    }

    phase = 'cloud-request-non-blocking'
    await withTimeout(
      control.awaitBlockedCloudRequest(BLOCKED_CLOUD_MODEL_PATH),
      WORKBENCH_READY_TIMEOUT_MS,
      'The connected desktop app did not start the intentionally blocked cloud model request'
    )
    await control.command('waitFor', '[data-testid="projects-create-button"]', {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    control.failBlockedCloudModels()
    await triggerModelReloadUntilCloudFailure(control)
    control.restoreCloudModels()
    await control.command('dispatchLocalModelSettingsChanged', '')
    const canonicalModelOption = `model-option-${DEFAULT_MODEL_ID}`
    const synthesizedModelOption = `model-option-codex-${DEFAULT_MODEL_ID}`
    const publicModelOption = `model-option-${CLOUD_PUBLIC_MODEL_NAME}`
    const recoveredModelMenu = await ensureModelOptionVisible(control, canonicalModelOption)
    assert.equal(
      recoveredModelMenu.testIds.filter(testId => testId === canonicalModelOption).length,
      1,
      'The canonical Executor model appeared more than once'
    )
    assert.equal(
      recoveredModelMenu.testIds.includes(synthesizedModelOption),
      false,
      'The Backend-synthesized runtime Codex duplicate remained visible'
    )
    assert.equal(
      (await ensureModelOptionVisible(control, publicModelOption)).testIds.includes(
        publicModelOption
      ),
      true,
      'The independent public model was removed while deduplicating runtime Codex'
    )
    await captureVerificationScreenshot(control, '00-canonical-model-catalog.png')
    await control.command('press', 'body', { key: 'Escape' })

    if (TOOL_BLOCK_ORDER_ONLY) {
      phase = 'tool-block-chronological-order'
      await verifyToolBlockChronologicalOrder({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      console.log(`Wework desktop tool-block-order E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (RETRY_ONLY) {
      phase = 'retry-failure-restoration'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyRetryFailureRestoration(control, ACTIVE_COMPOSER_SELECTOR)
      console.log(`Wework desktop retry-restoration E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GUIDANCE_SCROLL_ONLY) {
      phase = 'guidance-scroll'
      await verifyForegroundGuidanceScroll({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework guidance scroll desktop E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (RATE_LIMIT_ONLY) {
      phase = 'rate-limit-recovery'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyRateLimitRecovery({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      console.log(`Wework desktop rate-limit E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GOAL_IDLE_ONLY) {
      phase = 'goal-idle-state-lifecycle'
      await verifyActiveGoalIdleUnreadLifecycle({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorLogPath,
      })
      console.log(`Wework desktop Goal idle-state E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (GOAL_RESTART_ONLY) {
      phase = 'goal-restart-recovery'
      await verifyGoalRestartRecoveryLifecycle({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        executorLogPath,
        restartDesktopApp,
      })
      console.log(`Wework desktop Goal restart E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (TURN_NAVIGATION_ONLY) {
      phase = 'turn-navigation-only'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      control.setScenario('turn_navigation')
      for (let index = 0; index < TURN_NAVIGATION_REGRESSION_TURN_COUNT; index += 1) {
        const turnNumber = index + 1
        await sendPrompt(
          control,
          ACTIVE_COMPOSER_SELECTOR,
          `${TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX}_${turnNumber}`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: `${TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX}_${turnNumber}`,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          }
        )
      }
      console.log(
        'Turn navigation metrics:',
        await control.command('getElementMetrics', '[data-testid="desktop-workbench-content"]')
      )
      await control.command('waitFor', '[data-testid="message-turn-navigation-marker"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await reopenCurrentTurnNavigationTask(control, ACTIVE_COMPOSER_SELECTOR, restartDesktopApp)
      await verifyVirtualizedTurnNavigationActiveMarker(control)
      console.log(`Wework desktop turn-navigation E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (ATTACHMENT_ONLY) {
      phase = 'attachment-only-sidebar'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyAttachmentOnlySidebarLifecycle({
        app,
        appIdentifier,
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
      })
      console.log(`Wework desktop attachment-only E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (PASTED_WORKSPACE_PATHS_ONLY) {
      phase = 'pasted-workspace-paths'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyPastedWorkspacePaths({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        workspacePath,
      })
      console.log(`Wework desktop pasted-workspace-paths E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (DROPPED_WORKSPACE_PATHS_ONLY) {
      phase = 'dropped-workspace-paths'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyDroppedWorkspacePaths({
        composerSelector: ACTIVE_COMPOSER_SELECTOR,
        control,
        workspacePath,
      })
      console.log(`Wework desktop dropped-workspace-paths E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (SHORT_CONVERSATION_ONLY) {
      phase = 'short-conversation-layout'
      control.setScenario('fresh_chat')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      await verifyShortConversationLayout({ composerSelector: ACTIVE_COMPOSER_SELECTOR, control })
      console.log(`Wework desktop short-conversation E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (AUTOMATION_ONLY) {
      phase = 'automation-lifecycle'
      await verifyAutomationLifecycle(control, workspacePath)
      console.log(`Wework desktop automation E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (RUNS_PLUGIN_E2E) {
      let officialPluginFixture = null
      const ensureOfficialPluginFixture = async () => {
        officialPluginFixture ??= await installOfficialPluginFixture({
          codexHome,
          control,
          marketplacePath: pluginMarketplacePath,
          modelServerUrl: control.url,
          repositoryPath: officialPluginRepositoryPath,
          workspacePath,
        })
        return officialPluginFixture
      }

      if (shouldRunPluginSegment('plugin-lifecycle')) {
        phase = 'plugin-lifecycle'
        await verifyMarketplacePluginLifecycle({
          control,
          executorHome,
          marketplacePath: marketplacePluginPath,
          workspacePath,
        })
        await verifyPluginLifecycle({
          control,
          fixture: await ensureOfficialPluginFixture(),
        })
      }
      if (shouldRunPluginSegment('skill-mention-rendering')) {
        phase = 'skill-mention-rendering'
        await verifySkillMentionRendering({
          control,
          fixture: await ensureOfficialPluginFixture(),
        })
      }
      if (shouldRunPluginSegment('sites-plugin-auto-install')) {
        phase = 'sites-plugin-auto-install'
        await verifySitesPluginAutoInstall(control)
      }
      if (officialPluginFixture) {
        phase = 'plugin-uninstall'
        await uninstallOfficialPlugin(control, officialPluginFixture)
      }
      console.log(
        `Wework desktop plugin E2E${SELECTED_DESKTOP_SEGMENT ? ` segment ${SELECTED_DESKTOP_SEGMENT}` : ''} passed. Evidence: ${resultDir}`
      )
      return
    }

    if (desktopScenario && DESKTOP_SCENARIO_ONLY) {
      phase = 'desktop-extension-scenario'
      await desktopScenario.verify(control)
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework desktop extension scenario E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (shouldRunDesktopCheckpoint('workspace-tabs')) {
      phase = 'workspace-tab-isolation'
      await verifyWorkspaceTabIsolation(control)
      if (shouldStopAfterDesktopCheckpoint('workspace-tabs')) {
        console.log(`Wework desktop workspace-tabs checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('priority-filter')) {
      phase = 'priority-filter'
      await verifyPriorityFilter({ composerSelector: ACTIVE_COMPOSER_SELECTOR, control })
      if (shouldStopAfterDesktopCheckpoint('priority-filter')) {
        console.log(`Wework desktop priority-filter checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('telemetry-consent')) {
      phase = 'telemetry-preference'
      await verifyTelemetryPreference(control)
      verifyTelemetryRemainsDisabled(control)
      if (shouldStopAfterDesktopCheckpoint('telemetry-consent')) {
        console.log(`Wework desktop telemetry checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('core-task-flow')) {
      if (!GUIDANCE_SCROLL_ONLY) {
        phase = 'workspace-document-tabs'
        await verifyWorkspaceDocumentTabs(control)

        phase = 'automation-lifecycle'
        await verifyAutomationLifecycle(control, workspacePath)

        phase = 'cloud-work-page'
        await verifyCloudWorkPage(control)

        phase = 'system-drag-panel-layout'
        await verifySystemDragPanelLayout(control)
      }

      phase = 'remote-project-dialog'
      await control.command('click', '[data-testid="projects-create-button"]')
      await control.command('click', '[data-testid="project-create-remote-option"]')
      await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const remoteProjectDialogText = await control.command(
        'getText',
        '[data-testid="standalone-folder-project-dialog"]'
      )
      assert.match(
        remoteProjectDialogText,
        /New remote project|新建远程项目/,
        'The remote project dialog title was not localized'
      )
      await control.command('click', '[data-testid="standalone-folder-project-dialog-overlay"]')
      const closedRemoteDialogSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.equal(
        closedRemoteDialogSnapshot.testIds.includes('standalone-folder-project-dialog'),
        false,
        'Clicking the remote project dialog backdrop did not restore the workbench'
      )

      phase = 'project-folder-cancel'
      await control.command('click', '[data-testid="projects-create-button"]')
      await control.command('click', '[data-testid="project-create-local-option"]')
      await control.command('waitFor', '[data-testid="standalone-folder-project-dialog"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('waitFor', '[data-testid="cancel-device-folder-picker-button"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="cancel-device-folder-picker-button"]')
      const cancelledFolderPickerSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.equal(
        cancelledFolderPickerSnapshot.testIds.includes('standalone-folder-project-dialog'),
        false,
        'Cancelling folder selection did not restore the workbench'
      )
    }

    phase = 'secondary-project-create'
    const projectMenusBeforeSecondaryCreate = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await createSingleRootLocalProject(control, secondaryProjectPath, 'secondary-project')
    const secondaryProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId =>
            testId.startsWith('project-menu-') && !projectMenusBeforeSecondaryCreate.has(testId)
        ),
      'The standalone secondary project was not shown in the sidebar'
    )
    const secondaryProjectMenuTestId = secondaryProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-menu-') && !projectMenusBeforeSecondaryCreate.has(testId)
    )
    assert.ok(secondaryProjectMenuTestId, 'The standalone secondary project identity was not found')
    const secondaryProjectId = secondaryProjectMenuTestId.slice('project-menu-'.length)
    const secondaryProjectRowSelector = `[data-testid="project-row-${secondaryProjectId}"]`
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    phase = 'composer-project-folder-select'
    const projectMenusBeforeComposerCreate = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await control.command('click', '[data-testid="project-work-button"]')
    await control.command('click', '[data-testid="add-local-project-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await waitForFolderPickerInitialized(control)
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="device-folder-path-input"]'),
      workspacePath,
      'The device folder path did not update before confirmation'
    )
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, workspacePath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="local-project-create-name-input"]'),
      'workspace',
      'The project name did not default to the first source folder name'
    )
    await control.command('click', '[data-testid="add-local-project-create-folders"]')
    await control.command('waitFor', '[data-testid="local-project-create-folder-picker"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: secondaryProjectPath,
    })
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, secondaryProjectPath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-root-1"]', {
      text: 'secondary-project-root',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-local-project-create-button"]',
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )

    const composerSelector = ACTIVE_COMPOSER_SELECTOR
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })

    phase = 'composer-project-visible-in-sidebar'
    const openedProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId =>
            testId.startsWith('project-menu-') && !projectMenusBeforeComposerCreate.has(testId)
        ),
      'The newly opened folder project was not shown in the sidebar'
    )
    let projectMenuTestId = openedProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-menu-') && !projectMenusBeforeComposerCreate.has(testId)
    )
    assert.ok(projectMenuTestId, 'The newly opened folder project was not shown in the sidebar')
    let projectId = projectMenuTestId.slice('project-menu-'.length)
    let projectRowSelector = `[data-testid="project-row-${projectId}"]`
    await control.command('waitFor', projectRowSelector, {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await captureVerificationScreenshot(control, 'project-shared-root-both-visible.png')

    phase = 'sidebar-project-new-conversation'
    await control.command(
      'click',
      `${projectRowSelector} [data-testid="project-new-conversation-button"]`
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await control.command('waitFor', '[data-testid="project-work-button"]', {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    phase = 'project-folder-remove-immediately'
    await control.command('click', `[data-testid="${projectMenuTestId}"]`)
    await control.command('click', `[data-testid="remove-project-${projectId}"]`)
    await control.command(
      'click',
      `[data-testid="remove-project-dialog-${projectId}-confirm-button"]`
    )
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes(projectMenuTestId),
      'A folder project could not be removed immediately after it was opened'
    )
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    phase = 'project-folder-reopen'
    const projectMenusBeforeReopen = new Set(
      JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
        testId.startsWith('project-menu-')
      )
    )
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-local-option"]')
    await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await waitForFolderPickerInitialized(control)
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: workspacePath,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="device-folder-path-input"]'),
      workspacePath,
      'The device folder path did not update before confirmation'
    )
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, workspacePath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-dialog"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    assert.equal(
      await control.command('getValue', '[data-testid="local-project-create-name-input"]'),
      'workspace',
      'The reopened project name did not default to the first source folder name'
    )
    await control.command('click', '[data-testid="add-local-project-create-folders"]')
    await control.command('waitFor', '[data-testid="local-project-create-folder-picker"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('fill', '[data-testid="device-folder-path-input"]', {
      value: secondaryProjectPath,
    })
    await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
    await waitForFolderPathReady(control, secondaryProjectPath)
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-device-folder-picker-button"]',
      {
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', '[data-testid="local-project-create-root-1"]', {
      text: 'secondary-project-root',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="confirm-local-project-create-button"]',
      {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
    await control.command('waitFor', composerSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    const reopenedProjectSnapshot = await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.some(
          testId => testId.startsWith('project-menu-') && !projectMenusBeforeReopen.has(testId)
        ),
      'The reopened folder project was not shown with its current identity'
    )
    const reopenedProjectMenuTestId = reopenedProjectSnapshot.testIds.find(
      testId => testId.startsWith('project-menu-') && !projectMenusBeforeReopen.has(testId)
    )
    assert.ok(reopenedProjectMenuTestId, 'The reopened folder project identity was not found')
    projectMenuTestId = reopenedProjectMenuTestId
    projectId = projectMenuTestId.slice('project-menu-'.length)
    projectRowSelector = `[data-testid="project-row-${projectId}"]`
    await control.command('waitFor', projectRowSelector, {
      text: 'workspace',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('waitFor', secondaryProjectRowSelector, {
      text: 'secondary-project',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })

    let associatedTaskTabTestId = null
    if (shouldRunDesktopCheckpoint('core-task-flow')) {
      phase = 'project-space-default-association-setup'
      associatedTaskTabTestId = await configureDefaultProjectSpaceAssociation(control, projectId)
    }

    if (MIXED_TOOL_TURNS_ONLY) {
      phase = 'mixed-assistant-tool-turns'
      await verifyModelProtocolMatrix({
        cases: MIXED_TOOL_TURN_MODEL_PROTOCOL_MATRIX_CASES,
        composerSelector,
        control,
        newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
        screenshotPrefix: 'mixed-assistant-tool-turn',
        workspacePath,
      })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework mixed assistant tool-turn desktop E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (QUEUE_MANAGEMENT_ONLY) {
      phase = 'queue-management'
      await verifyPausedQueueLifecycle({ composerSelector, control })
      await writeFile(
        join(resultDir, 'model-requests.json'),
        `${JSON.stringify(control.modelRequests, null, 2)}\n`,
        'utf8'
      )
      console.log(`Wework queue management desktop E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (TASK_PLAN_ONLY) {
      phase = 'background-task-plan'
      await verifyBackgroundTaskPlanRestoration({ composerSelector, control })
      console.log(`Wework background task-plan E2E passed. Evidence: ${resultDir}`)
      return
    }

    if (MEMORY_ONLY) {
      phase = 'memory-growth'
      await selectE2EModel(control)
      await verifyMemoryGrowth({ composerSelector, control })
      phase = 'concurrent-memory'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
      await verifyConcurrentTaskMemory({ composerSelector, control })
      console.log(`Wework desktop memory E2E passed. Evidence: ${resultDir}`)
      return
    }

    let taskRowTestId
    let taskRowCompletionText = COMPLETION_TEXT
    if (shouldRunDesktopCheckpoint('core-task-flow')) {
      const activeModelSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
      await control.command('waitFor', activeModelSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      control.setScenario('initial')
      const taskRowsBeforeInitialTask = new Set(
        JSON.parse(await control.command('snapshot', 'body')).testIds.filter(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      )
      phase = 'initial-task'
      await sendPrompt(control, composerSelector, TASK_PROMPT)
      await withTimeout(
        control.awaitScenarioRequest('initial'),
        DEFAULT_STEP_TIMEOUT_MS,
        'The model service did not receive the initial task request'
      )
      const runningTaskSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.some(
            testId =>
              testId.startsWith('runtime-local-task-row-') && !taskRowsBeforeInitialTask.has(testId)
          ),
        'The initial task row was not available before its response completed'
      )
      taskRowTestId = runningTaskSnapshot.testIds.find(
        testId =>
          testId.startsWith('runtime-local-task-row-') && !taskRowsBeforeInitialTask.has(testId)
      )
      assert.ok(taskRowTestId, 'The initial task row identity was not found')
      await verifyUserMessageNavigation({
        control,
        projectRowSelector,
        screenshotPrefix: 'initial-message-pending',
        taskRowTestId,
        userText: TASK_PROMPT,
      })

      if (VIEW_IMAGE_ONLY || MESSAGE_RESTORATION_ONLY) {
        control.releaseInitialToolExecution()
      } else {
        phase = 'send-mode-menu'
        await control.command('waitFor', '[data-testid="pause-response-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await control.command('fill', composerSelector, { value: SEND_MODE_DRAFT })
        await control.command('waitFor', '[data-testid="send-mode-menu-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await captureVerificationScreenshot(control, '01-send-mode-follow-up-ready.png')
        await control.command('click', '[data-testid="send-mode-menu-button"]')
        await control.command('waitFor', '[data-testid="send-mode-menu-button-menu"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        const sendModeMenuText = await control.command(
          'getText',
          '[data-testid="send-mode-menu-button-menu"]'
        )
        assert.match(
          sendModeMenuText,
          /当前回复结束后发送|Send after current response/,
          'The send-after-turn option was not visible in the send mode menu'
        )
        assert.match(
          sendModeMenuText,
          /引导当前回复|Guide current response/,
          'The guide-current-turn option was not visible in the send mode menu'
        )
        assert.match(
          sendModeMenuText,
          /打断并立即发送|Interrupt and send now/,
          'The interrupt-and-send option was not visible in the send mode menu'
        )
        await captureVerificationScreenshot(control, '02-send-mode-menu-open.png')
        await control.command('press', 'body', { key: 'Escape' })
        await control.command('fill', composerSelector, { value: '' })
        if (!GUIDANCE_BACKGROUND_ONLY) {
          await verifyQueuedFollowUpNavigation({
            composerSelector,
            control,
            projectRowSelector,
            runningTaskRowTestId: taskRowTestId,
          })
        }
        if (QUEUE_NAVIGATION_ONLY) {
          await writeFile(
            join(resultDir, 'model-requests.json'),
            `${JSON.stringify(control.modelRequests, null, 2)}\n`,
            'utf8'
          )
          console.log(`Wework queue navigation desktop E2E passed. Evidence: ${resultDir}`)
          return
        }
        const backgroundNavigationTaskRowTestId = await createCheckpointTaskFixture(
          control,
          composerSelector
        )
        control.setScenario('initial')
        await ensureTaskRowVisible(control, taskRowTestId)
        await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await control.command('waitFor', '[data-testid="pause-response-button"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        taskRowTestId = await verifyBackgroundGuidanceNavigation({
          composerSelector,
          control,
          otherTaskRowTestId: backgroundNavigationTaskRowTestId,
          runningTaskRowTestId: taskRowTestId,
        })
        if (GUIDANCE_BACKGROUND_ONLY) {
          await writeFile(
            join(resultDir, 'model-requests.json'),
            `${JSON.stringify(control.modelRequests, null, 2)}\n`,
            'utf8'
          )
          console.log(`Wework background guidance desktop E2E passed. Evidence: ${resultDir}`)
          return
        }
      }

      phase = 'initial-task-completion'
      if (control.modelStage !== 'complete') {
        control.releaseInitialToolExecution()
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await verifyUserMessageNavigation({
        assistantText: COMPLETION_TEXT,
        control,
        projectRowSelector,
        screenshotPrefix: 'initial-message-completed',
        taskRowTestId,
        userText: TASK_PROMPT,
      })
      if (associatedTaskTabTestId) {
        phase = 'project-space-selected-task-tracked'
        await verifyExplicitlyTrackedTask(control, associatedTaskTabTestId)
      }
      if (MESSAGE_RESTORATION_ONLY) {
        await verifyFollowUpMessageRestoration({
          composerSelector,
          control,
          projectRowSelector,
          taskRowTestId,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework message restoration desktop E2E passed. Evidence: ${resultDir}`)
        return
      }
      await control.command('click', '[data-testid="final-processing-toggle"]')
      await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const processingSummaryText = await control.command(
        'getText',
        '[data-testid="processing-summary-toggle"]'
      )
      assert.match(
        processingSummaryText,
        /编辑 1 个文件|edited 1 file/,
        'The processing summary did not report the edited file'
      )
      await control.command('waitFor', '[aria-label="编辑 1"], [aria-label="Edits 1"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      if (process.platform === 'darwin') {
        await control.command('scrollIntoView', '[data-testid="processing-summary-header"]')
        await control.command('waitFor', '[data-testid="processing-summary-toggle"]', {
          visible: true,
          stableMs: 500,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
        const processingSummaryScreenshot = await control.command(
          'capture',
          '[data-testid="processing-summary-toggle"]'
        )
        await writeFile(
          join(resultDir, 'processing-summary.png'),
          Buffer.from(processingSummaryScreenshot.replace(/^data:image\/png;base64,/, ''), 'base64')
        )
      }
      await control.command('click', '[data-testid="processing-summary-toggle"]')
      await control.command('waitFor', '[data-testid="file-change-stats-label"]', {
        text: '+1',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      if (VIEW_IMAGE_ONLY) {
        await verifyViewImageProcessingBlock(control)
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework view_image desktop E2E passed. Evidence: ${resultDir}`)
        return
      }
      const changedEnvironmentText = await control.command(
        'getText',
        '[data-testid="file-change-stats-label"]'
      )
      assert.match(
        changedEnvironmentText,
        /\+1\s*-0/,
        'The real apply_patch result did not render the expected file diff'
      )

      phase = 'workspace-mention'
      await control.command('fill', composerSelector, { value: '@auth' })
      await control.command('waitFor', '[data-testid="workspace-mention-option-0"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="workspace-mention-option-0"]')
      await control.command('waitFor', '[data-testid="composer-path-chip-auth-ts"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('fill', composerSelector, { value: '' })

      assert.equal(
        await readFile(join(workspacePath, ARTIFACT_NAME), 'utf8'),
        `${ARTIFACT_CONTENT}\n`,
        'The real Codex tool execution did not create the expected workspace artifact'
      )
      assert.equal(
        control.modelStage,
        'complete',
        'The model service did not complete the Codex tool loop'
      )
      assert.ok(
        control.modelRequests.length >= 2,
        'The real Codex did not make both model requests'
      )
      assert.ok(
        control.catalogRequests.length >= 1,
        'The Codex model catalog did not pass through the local router'
      )
      assert.ok(
        typeof control.modelRequests[0].body.model === 'string' &&
          control.modelRequests[0].body.model.length > 0,
        'The real Codex request did not select a model'
      )
      assert.ok(
        control.toolOutput,
        'Codex did not report its real tool execution to the model service'
      )

      phase = 'conversation-model-restore'
      if (!taskRowTestId) {
        const taskSnapshot = await waitForSnapshot(
          control,
          snapshot => snapshot.testIds.some(testId => testId.startsWith('runtime-local-task-row-')),
          'The completed task was not available for model restoration'
        )
        taskRowTestId = taskSnapshot.testIds.find(testId =>
          testId.startsWith('runtime-local-task-row-')
        )
      }
      assert.ok(taskRowTestId, 'The completed task row was not found')

      if (SIDE_CHAT_ONLY) {
        phase = 'side-chat-attachment-isolation'
        await verifySideChatAttachmentIsolation({ control, taskRowTestId })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework side-chat desktop E2E passed. Evidence: ${resultDir}`)
        return
      }

      if (RUNNING_FORK_ONLY) {
        phase = 'running-follow-up-fork'
        await verifyRunningFollowUpFork({
          composerSelector,
          control,
          executorHome,
          sourceTaskRowTestId: taskRowTestId,
        })
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework running-fork desktop E2E passed. Evidence: ${resultDir}`)
        return
      }

      if (!COMPLETED_FORK_ONLY) {
        phase = 'running-follow-up-fork'
        await verifyRunningFollowUpFork({
          composerSelector,
          control,
          executorHome,
          sourceTaskRowTestId: taskRowTestId,
        })
      }

      phase = 'completed-turn-fork'
      await verifyCompletedTurnFork({
        composerSelector,
        control,
        executorHome,
        sourceTaskRowTestId: taskRowTestId,
        workspacePath,
      })
      if (COMPLETED_FORK_ONLY) {
        await writeFile(
          join(resultDir, 'model-requests.json'),
          `${JSON.stringify(control.modelRequests, null, 2)}\n`,
          'utf8'
        )
        console.log(`Wework completed-fork desktop E2E passed. Evidence: ${resultDir}`)
        return
      }

      phase = 'blank-task-draft-restoration'
      await control.command(
        'clickWhenEnabled',
        `${projectRowSelector} [data-testid="project-new-conversation-button"]`
      )
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('fill', composerSelector, { value: UNSENT_BLANK_TASK_DRAFT })
      await waitForPersistedComposerInput(
        control,
        UNSENT_BLANK_TASK_DRAFT,
        'The blank task composer did not persist its draft before switching tasks'
      )
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: COMPLETION_TEXT,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command(
        'clickWhenEnabled',
        `${projectRowSelector} [data-testid="project-new-conversation-button"]`
      )
      await waitForControlValue(
        control,
        composerSelector,
        UNSENT_BLANK_TASK_DRAFT,
        'The blank task lost its unsent composer draft after switching tasks'
      )
      await waitForControlSelectionOffset(
        control,
        composerSelector,
        UNSENT_BLANK_TASK_DRAFT.length,
        'The restored blank task draft did not place the caret at the end'
      )
      await control.command('fill', composerSelector, { value: '' })

      if (!REQUEST_INPUT_ONLY) {
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', composerSelector, {
          timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
        })
        await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
        await ensureTaskRowVisible(control, taskRowTestId)
        await control.command('click', `[data-testid="${taskRowTestId}"]`)
        await control.command('waitFor', '[data-testid="model-selector-button"]', {
          text: DEFAULT_MODEL_LABEL,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })

        phase = 'follow-up'
        await verifyFollowUpMessageRestoration({
          composerSelector,
          control,
          projectRowSelector,
          taskRowTestId,
        })

        for (const [switchIndex, switchCase] of LOCAL_MODEL_SWITCH_CASES.entries()) {
          phase = `local-model-switch-${switchCase.id}`
          const sourceModel = LOCAL_MODEL_CASES.find(
            model => model.protocol === switchCase.sourceProtocol
          )
          const targetModel = LOCAL_MODEL_CASES.find(
            model => model.protocol === switchCase.targetProtocol
          )
          assert.ok(sourceModel, `Missing ${switchCase.sourceProtocol} local switch source`)
          assert.ok(targetModel, `Missing ${switchCase.targetProtocol} local switch target`)
          for (const model of LOCAL_MODEL_CASES) {
            control.localProtocolStates.set(model.protocol, { stage: 'initial', requests: [] })
          }
          control.localProtocolStates.set(sourceModel.protocol, {
            stage: 'model_switch_source',
            requests: [],
          })
          control.localProtocolStates.set(targetModel.protocol, {
            stage: 'model_switch_target',
            requests: [],
          })
          await rm(join(workspacePath, LOCAL_MODEL_SWITCH_ARTIFACT), { force: true })
          await control.command('click', '[data-testid="new-chat-button"]')
          await control.command('waitFor', composerSelector, {
            timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
          })
          await selectE2EModel(control, sourceModel.optionId, sourceModel.label)
          await sendPrompt(control, composerSelector, LOCAL_MODEL_SWITCH_INITIAL_PROMPT)
          await control.command('waitFor', '[data-testid="message-assistant"]', {
            text: LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          })
          await sendPrompt(control, composerSelector, LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT)
          await control.command('waitFor', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
            visible: true,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          })
          const sourceRequestsBeforeSwitch = control.localProtocolStates.get(sourceModel.protocol)
            ?.requests.length
          assert.ok(
            sourceRequestsBeforeSwitch && sourceRequestsBeforeSwitch >= 3,
            `${switchCase.id} did not complete its source tool loop and failed follow-up`
          )
          if (switchIndex === 0) {
            await prepareCompletedTurnScreenshot(control)
            await captureVerificationScreenshot(control, 'model-switch-retry-01-failed.png')
          }
          await control.command('scrollIntoView', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR)
          await control.command('clickWhenEnabled', ACTIVE_SWITCH_MODEL_RETRY_SELECTOR, {
            stableMs: COMPOSER_READY_STABILITY_MS,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          })
          await control.command('waitFor', '[data-testid="model-selector-menu"]', {
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          })
          if (switchIndex === 0) {
            await captureVerificationScreenshot(
              control,
              'model-switch-retry-02-picker-open.png',
              '[data-testid="model-selector-menu"]'
            )
          }
          await selectE2EModel(control, targetModel.optionId, targetModel.label)
          if (switchIndex === 0) {
            await captureVerificationScreenshot(
              control,
              'model-switch-retry-03-target-selected.png'
            )
          }
          await control.command('waitFor', '[data-testid="message-assistant"]', {
            text: LOCAL_MODEL_SWITCH_COMPLETE,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          })
          assert.equal(
            await readFile(join(workspacePath, LOCAL_MODEL_SWITCH_ARTIFACT), 'utf8'),
            LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
            `${switchCase.id} did not execute its source tool call before switching`
          )
          const sourceSwitchState = control.localProtocolStates.get(sourceModel.protocol)
          const targetSwitchState = control.localProtocolStates.get(targetModel.protocol)
          assert.equal(
            sourceSwitchState?.requests.length,
            sourceRequestsBeforeSwitch,
            `${switchCase.id} retried through the old custom model`
          )
          assert.equal(
            targetSwitchState?.stage,
            'model_switch_target_complete',
            `${switchCase.id} did not complete the automatic same-conversation retry`
          )
          await control.command('waitFor', '[data-testid="model-selector-button"]', {
            text: targetModel.label,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          })
          await waitForSnapshot(
            control,
            snapshot => !/下一轮|Next/.test(snapshot.text),
            `${switchCase.id} left the applied model marked as next-turn only`,
            DEFAULT_STEP_TIMEOUT_MS,
            '[data-testid="model-selector-button"]'
          )
          modelSwitchVerification.push({
            direction: switchCase.id,
            sourceProtocol: sourceModel.protocol,
            targetProtocol: targetModel.protocol,
            sourceRequestCount: sourceSwitchState.requests.length,
            targetRequestCount: targetSwitchState.requests.length,
            targetHistoryVerified: targetSwitchState.historyVerified === true,
            toolArtifactVerified: true,
            completed: true,
          })
          if (switchIndex === 0) {
            await prepareCompletedTurnScreenshot(control)
            await captureVerificationScreenshot(control, 'model-switch-retry-04-completed.png')
          }
        }
        phase = 'provider-switch-retry'
        await verifyCrossProviderSwitchRetry(control, composerSelector)
        phase = 'local-vision-sidecar'
        await verifyVisionSidecar({
          composerSelector,
          control,
          modelCase: LOCAL_VISION_SIDECAR_CASE,
          projectRowSelector,
        })
        await writeFile(
          join(resultDir, 'model-switch-protocol-verification.json'),
          `${JSON.stringify(modelSwitchVerification, null, 2)}\n`,
          'utf8'
        )
        if (MODEL_SWITCH_ONLY) {
          assert.deepEqual(
            modelSwitchVerification.map(result => result.direction),
            LOCAL_MODEL_SWITCH_CASES.map(result => result.id),
            'The focused model-switch E2E did not verify all six protocol directions'
          )
          await writeFile(
            join(resultDir, 'model-requests.json'),
            `${JSON.stringify(control.modelRequests, null, 2)}\n`,
            'utf8'
          )
          console.log(`Wework desktop six-way model-switch E2E passed. Evidence: ${resultDir}`)
          return
        }

        phase = 'local-model-protocol-matrix'
        await verifyModelProtocolMatrix({
          cases: LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
          composerSelector,
          control,
          newConversationSelector: `${projectRowSelector} [data-testid="project-new-conversation-button"]`,
          screenshotPrefix: 'local-matrix',
          workspacePath,
        })

        await ensureTaskRowVisible(control, taskRowTestId)
        await control.command('click', `[data-testid="${taskRowTestId}"]`)
        await control.command('waitFor', '[data-testid="model-selector-button"]', {
          text: DEFAULT_MODEL_LABEL,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
      }

      phase = 'background-task-plan'
      await verifyBackgroundTaskPlanRestoration({ composerSelector, control })

      phase = 'background-request-user-input'
      control.setScenario('request_user_input')
      await ensurePlanMode(control)
      await sendPromptUntilScenarioRequest(
        control,
        composerSelector,
        REQUEST_USER_INPUT_PROMPT,
        'request_user_input'
      )
      const requestInputDebugSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const requestInputTaskId = requestInputDebugSnapshot.workbench?.currentRuntimeTask?.taskId
      assert.ok(
        requestInputTaskId,
        'The request-user-input task did not expose its runtime task ID'
      )
      const requestInputTaskRowTestId = `runtime-local-task-row-${requestInputTaskId}`
      await control.command('waitFor', `[data-testid="${requestInputTaskRowTestId}"]`, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('click', composerSelector)
      await control.command('press', 'body', { key: 'Escape' })
      await captureVerificationScreenshot(control, '01-request-running-in-background.png')
      await withTimeout(
        control.releaseRequestUserInputResponse(),
        DEFAULT_STEP_TIMEOUT_MS,
        'Timed out waiting for the request-user-input SSE response'
      )
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('click', `[data-testid="${requestInputTaskRowTestId}"]`)
      await control.command('waitFor', '[data-testid="request-user-input-card"]', {
        text: REQUEST_USER_INPUT_QUESTION,
        visible: true,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await captureVerificationScreenshot(control, '02-background-request-user-input-visible.png')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000))
      await control.command('click', '[data-testid="request-user-input-option-direction-1"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: REQUEST_USER_INPUT_COMPLETION_TEXT,
        visible: true,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await captureVerificationScreenshot(control, '03-delayed-answer-completed.png')
      await control.command('click', '[data-testid="cancel-plan-mode-button"]')
      if (REQUEST_INPUT_ONLY) return
      if (shouldStopAfterDesktopCheckpoint('core-task-flow')) {
        console.log(`Wework desktop core-task-flow checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('window-lifecycle')) {
      taskRowTestId = await verifyBackgroundTaskWindowLifecycle({
        app,
        appIdentifier,
        composerSelector,
        control,
        executorLogPath,
        restartDesktopApp,
        setPhase: value => {
          phase = value
        },
      })
      taskRowCompletionText = WINDOW_LIFECYCLE_COMPLETION_TEXT
      if (shouldStopAfterDesktopCheckpoint('window-lifecycle')) {
        console.log(`Wework desktop window-lifecycle checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('goal-lifecycle')) {
      phase = 'goal-idle-unread'
      await verifyActiveGoalIdleUnreadLifecycle({
        composerSelector,
        control,
        executorLogPath,
      })

      phase = 'goal-restart-recovery'
      await verifyGoalRestartRecoveryLifecycle({
        composerSelector,
        control,
        executorLogPath,
        restartDesktopApp,
      })
      if (shouldStopAfterDesktopCheckpoint('goal-lifecycle')) {
        console.log(`Wework desktop goal-lifecycle checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('supervisor-lifecycle')) {
      phase = 'supervisor-lifecycle'
      await verifyTaskSupervisorLifecycle({ composerSelector, control })
      if (shouldStopAfterDesktopCheckpoint('supervisor-lifecycle')) {
        console.log(`Wework desktop supervisor-lifecycle checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('resilience')) {
      phase = 'queue-management'
      await verifyPausedQueueLifecycle({ composerSelector, control })

      phase = 'cancellation'
      control.setScenario('cancellation')
      await sendPrompt(control, composerSelector, CANCELLATION_PROMPT)
      await withTimeout(
        control.awaitScenarioRequest('cancellation'),
        DEFAULT_STEP_TIMEOUT_MS,
        'The model service did not receive the cancellation request'
      )
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', '[data-testid="pause-response-button"]')
      await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const cancelledTaskSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const cancelledTaskId = cancelledTaskSnapshot.workbench?.currentRuntimeTask?.taskId
      assert.ok(cancelledTaskId, 'The cancelled task did not expose its runtime task ID')
      const cancelledTaskUnreadTestId = `runtime-local-task-unread-dot-${cancelledTaskId}`
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes(cancelledTaskUnreadTestId),
        'Stopping the task being viewed incorrectly marked it unread'
      )
      const cancellationText = await control.command('getText', 'body')
      assert.equal(
        cancellationText.includes(CANCELLATION_COMPLETION_TEXT),
        false,
        'The cancelled task unexpectedly rendered a completion response'
      )
      control.releaseCancellationResponse()
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
      const cancellationTextAfterUpstreamCompletion = await control.command('getText', 'body')
      assert.equal(
        cancellationTextAfterUpstreamCompletion.includes(CANCELLATION_COMPLETION_TEXT),
        false,
        'The cancelled task rendered content emitted after cancellation'
      )
      const cancellationSnapshotAfterUpstreamCompletion = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      assert.equal(
        cancellationSnapshotAfterUpstreamCompletion.workbench?.lifecycleCurrentTaskRunning,
        false,
        'The cancelled task resumed after the upstream completion response'
      )
      assert.equal(
        cancellationSnapshotAfterUpstreamCompletion.pane?.status?.isBusy,
        false,
        'The cancelled task made the composer busy after the upstream completion response'
      )
      const cancellationUiAfterUpstreamCompletion = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        cancellationUiAfterUpstreamCompletion.testIds.includes('pause-response-button'),
        false,
        'The cancelled task restored the stop control after the upstream completion response'
      )

      phase = 'retry'
      await verifyRetryFailureRestoration(control, composerSelector)

      phase = 'rate-limit-recovery'
      await verifyRateLimitRecovery({ composerSelector, control })

      phase = 'reconnect'
      await verifyReconnectRecovery({ composerSelector, control })
      if (shouldStopAfterDesktopCheckpoint('resilience')) {
        console.log(`Wework desktop resilience checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('conversation-state')) {
      if (!taskRowTestId) {
        taskRowTestId = await createCheckpointTaskFixture(control, composerSelector)
        taskRowCompletionText = CHECKPOINT_TASK_COMPLETION_TEXT
      }
      phase = 'fresh-chat'
      control.setScenario('fresh_chat')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      const freshChatSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.equal(
        freshChatSnapshot.text.includes(TASK_PROMPT),
        false,
        'The new conversation retained the previous task'
      )
      const secondTaskRowTestId = await verifyShortConversationLayout({
        composerSelector,
        control,
      })

      phase = 'task-draft-isolation'
      await control.command('fill', composerSelector, { value: UNSENT_SECOND_TASK_DRAFT })
      await waitForPersistedComposerInput(
        control,
        UNSENT_SECOND_TASK_DRAFT,
        'The second task composer did not persist its draft before switching tasks'
      )
      await ensureTaskRowVisible(control, taskRowTestId)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await control.command('fill', composerSelector, { value: UNSENT_FIRST_TASK_DRAFT })
      await waitForPersistedComposerInput(
        control,
        UNSENT_FIRST_TASK_DRAFT,
        'The first task composer did not persist its draft before switching tasks'
      )
      await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
      await waitForControlValue(
        control,
        composerSelector,
        UNSENT_SECOND_TASK_DRAFT,
        'The second task lost its unsent composer draft after switching tasks'
      )
      await ensureTaskRowVisible(control, taskRowTestId)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      await waitForControlValue(
        control,
        composerSelector,
        UNSENT_FIRST_TASK_DRAFT,
        'The first task lost its unsent composer draft after switching tasks'
      )

      phase = 'file-panel-scroll-anchor'
      control.setScenario('file_panel_anchor')
      await sendPrompt(control, composerSelector, FILE_PANEL_ANCHOR_PROMPT)
      const filePanelAnchorScopeSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"] [data-scroll-anchor]`
      const filePanelAnchorSelector = '[data-e2e-anchor-id="file-panel-anchor"]'
      const conversationScrollerSelector = '[data-testid="desktop-workbench-content"]'
      await control.command('waitFor', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('scrollIntoViewAsUser', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        value: 'start',
      })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      await control.command('markElementWithText', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        value: 'file-panel-anchor',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const { element: filePanelAnchorBeforeOpen, scroller: filePanelScrollerBeforeOpen } =
        await waitForElementInsideScroller(
          control,
          filePanelAnchorSelector,
          conversationScrollerSelector,
          'The linked file paragraph before opening the file panel'
        )
      assert.ok(
        distanceFromBottom(filePanelScrollerBeforeOpen) > 100,
        'The linked file paragraph did not move the conversation away from the bottom'
      )
      await captureVerificationScreenshot(control, 'file-panel-anchor-01-before-open.png')

      await control.command(
        'click',
        `${filePanelAnchorSelector} [data-testid="assistant-markdown-link"]`
      )
      await control.command('waitFor', '[data-testid="right-workspace-file-tab"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('finishAnimations', 'body')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      const filePanelScrollerAfterOpen = await getSingleElementMetrics(
        control,
        conversationScrollerSelector,
        'The conversation after opening a linked file'
      )
      const filePanelAnchorAfterOpen = await getSingleElementMetrics(
        control,
        filePanelAnchorSelector,
        'The linked file paragraph after opening the file panel'
      )
      assert.ok(
        filePanelScrollerAfterOpen.width < filePanelScrollerBeforeOpen.width - 100,
        `Opening the file panel did not resize the conversation from ${filePanelScrollerBeforeOpen.width}px; after=${filePanelScrollerAfterOpen.width}px`
      )
      assert.ok(
        Math.abs(filePanelAnchorAfterOpen.top - filePanelAnchorBeforeOpen.top) <= 8,
        `Opening the file panel moved the linked paragraph from ${filePanelAnchorBeforeOpen.top}px to ${filePanelAnchorAfterOpen.top}px`
      )
      assert.ok(
        filePanelAnchorAfterOpen.top >= filePanelScrollerAfterOpen.top - 2 &&
          filePanelAnchorAfterOpen.bottom <= filePanelScrollerAfterOpen.bottom + 2,
        `The linked file paragraph left the conversation viewport after opening the file panel: ${JSON.stringify(
          {
            anchor: filePanelAnchorAfterOpen,
            scroller: filePanelScrollerAfterOpen,
          }
        )}`
      )
      await captureVerificationScreenshot(control, 'file-panel-anchor-02-after-open.png')
      await control.command('click', '[data-testid="right-workspace-file-tab-close-button"]')
      await waitForSnapshot(
        control,
        snapshot => !snapshot.testIds.includes('right-workspace-file-tab'),
        'The file panel remained open after the anchor regression check',
        DEFAULT_STEP_TIMEOUT_MS,
        ACTIVE_WORKBENCH_SELECTOR
      )
      await control.command('finishAnimations', 'body')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      const filePanelScrollerAfterClose = await getSingleElementMetrics(
        control,
        conversationScrollerSelector,
        'The conversation after closing a linked file'
      )
      const filePanelAnchorAfterClose = await getSingleElementMetrics(
        control,
        filePanelAnchorSelector,
        'The linked file paragraph after closing the file panel'
      )
      assert.ok(
        Math.abs(filePanelScrollerAfterClose.width - filePanelScrollerBeforeOpen.width) <= 1,
        `Closing the file panel did not restore the conversation width from ${filePanelScrollerAfterOpen.width}px; after=${filePanelScrollerAfterClose.width}px`
      )
      assert.ok(
        Math.abs(filePanelAnchorAfterClose.top - filePanelAnchorBeforeOpen.top) <= 8,
        `Closing the file panel moved the linked paragraph from ${filePanelAnchorBeforeOpen.top}px to ${filePanelAnchorAfterClose.top}px`
      )

      phase = 'workspace-resources-across-conversation-switch'
      await writeFile(
        join(workspacePath, GIT_SEED_NAME),
        `${GIT_SEED_CONTENT}${FILE_PREVIEW_RESTORE_MARKER}\n`
      )
      const firstTaskDebugSnapshot = JSON.parse(
        await control.command('getWorkbenchDebugSnapshot', 'body')
      )
      const firstTaskWorkspacePath =
        firstTaskDebugSnapshot.workbench?.currentRuntimeTask?.workspacePath
      assert.ok(
        firstTaskWorkspacePath,
        'The first task did not expose a workspace path for review restoration'
      )
      const activeWorkspaceTabSelector =
        '[data-testid^="workspace-tab-select-task-"][aria-selected="true"]'
      await control.command('waitFor', activeWorkspaceTabSelector, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      const activeWorkspaceTabTestId = await control.command(
        'getAttribute',
        activeWorkspaceTabSelector,
        { value: 'data-testid' }
      )
      const activeWorkspaceTabId = activeWorkspaceTabTestId.replace('workspace-tab-select-', '')
      assert.ok(
        activeWorkspaceTabId.startsWith('task-'),
        `Expected an active task workspace tab, received ${activeWorkspaceTabTestId}`
      )
      const activeTaskWorkbenchSelector =
        `[data-testid="workspace-tab-content-${activeWorkspaceTabId}"] ` +
        '[data-testid="desktop-workbench-main"]'
      const firstTaskReadme = join(firstTaskWorkspacePath, GIT_SEED_NAME)
      await writeFile(
        firstTaskReadme,
        `${await readFile(firstTaskReadme, 'utf8')}${REVIEW_RESTORE_MARKER}\n`
      )
      const activeBrowserInputSelector = `${activeTaskWorkbenchSelector} [data-testid="workspace-browser-url-input"]`
      const activeTerminalSelector = `${activeTaskWorkbenchSelector} [data-testid="workspace-terminal-window"]`
      const bottomPanelToggleSelector = '[data-testid="toggle-bottom-workspace-panel-button"]'
      const bottomWorkspaceTabCloseSelector = '[data-testid="close-bottom-workspace-tab-button"]'
      const rightBrowserTabCloseSelector =
        '[data-testid="right-workspace-browser-tab-close-button"]'
      const retainedBrowserUrl = 'https://example.com/session-state'
      await control.command('waitFor', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('markElementWithText', filePanelAnchorScopeSelector, {
        text: FILE_PANEL_ANCHOR_MARKER,
        value: 'file-panel-anchor',
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command(
        'click',
        `${filePanelAnchorSelector} [data-testid="assistant-markdown-link"]`
      )
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="workspace-markdown-preview"]`,
        {
          text: FILE_PREVIEW_RESTORE_MARKER,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.equal(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="workspace-file-path"]`
        ),
        join(workspacePath, GIT_SEED_NAME),
        'The linked absolute file opened from the wrong workspace target'
      )
      await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
      await control.command('click', '[data-testid="right-workspace-browser-option"]')
      await control.command('waitFor', activeBrowserInputSelector, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('fill', activeBrowserInputSelector, { value: retainedBrowserUrl })
      await control.command('submit', activeBrowserInputSelector)
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="workspace-browser-native-view"]`,
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command('click', bottomPanelToggleSelector)
      const firstTaskBottomWorkspaceSnapshot = await waitForSnapshot(
        control,
        value => {
          const terminalOpened =
            value.testIds.includes('workspace-terminal-window') &&
            !value.testIds.includes('workspace-tool-launcher')
          const localTerminalUnavailable =
            value.testIds.includes('workspace-tool-launcher') &&
            value.testIds.includes('workspace-local-device-limited-tools')
          return terminalOpened || localTerminalUnavailable
        },
        'The first task bottom workspace panel did not open a terminal or limited-tools launcher',
        DEFAULT_STEP_TIMEOUT_MS,
        activeTaskWorkbenchSelector
      )
      const firstTaskOpenedTerminal = firstTaskBottomWorkspaceSnapshot.testIds.includes(
        'workspace-terminal-window'
      )
      await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
      await control.command('click', '[data-testid="right-workspace-review-option"]')
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="review-view-switcher-button"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command(
        'click',
        `${activeTaskWorkbenchSelector} [data-testid="review-view-switcher-button"]`
      )
      await control.command('click', '[data-testid="review-view-switcher-option"]:first-child')
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-tree"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-diff-toggle"]`,
        {
          text: GIT_SEED_NAME,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.match(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-toolbar"]`
        ),
        /\+2\s*-0/,
        'The review fixture did not expose both README additions before switching tasks'
      )
      await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
      const secondTaskId = secondTaskRowTestId.replace('runtime-local-task-row-', '')
      await waitForWorkbenchDebugState(
        control,
        snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === secondTaskId,
        'The workbench did not switch to the second task before checking workspace isolation'
      )
      const secondTaskWorkspaceSnapshot = JSON.parse(
        await control.command('snapshot', activeTaskWorkbenchSelector)
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-terminal-window'),
        false,
        'The first task terminal leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-browser-panel'),
        false,
        'The first task browser leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-markdown-preview'),
        false,
        'The first task file preview leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('file-changes-review-panel'),
        false,
        'The first task review leaked into the second task'
      )
      assert.equal(
        secondTaskWorkspaceSnapshot.testIds.includes('workspace-tool-launcher'),
        false,
        'The first task bottom workspace launcher leaked into the second task'
      )
      await ensureTaskRowVisible(control, taskRowTestId)
      await control.command('click', `[data-testid="${taskRowTestId}"]`)
      if (firstTaskOpenedTerminal) {
        await control.command('waitFor', activeTerminalSelector, {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
      } else {
        await waitForSnapshot(
          control,
          value =>
            value.testIds.includes('bottom-workspace-panel') &&
            value.testIds.includes('workspace-tool-launcher') &&
            value.testIds.includes('workspace-local-device-limited-tools'),
          'The first task bottom workspace limited-tools state was not restored',
          DEFAULT_STEP_TIMEOUT_MS,
          activeTaskWorkbenchSelector
        )
      }
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-tree"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-file-diff-toggle"]`,
        {
          text: GIT_SEED_NAME,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.match(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="file-changes-review-toolbar"]`
        ),
        /\+2\s*-0/,
        'The restored review lost the README diff statistics'
      )
      assert.equal(
        await control.command('getAttribute', '[data-testid="right-workspace-review-tab"]', {
          value: 'aria-selected',
        }),
        'true',
        'The review tab was not active after switching back to the first task'
      )
      await control.command('click', '[data-testid="right-workspace-file-tab"]')
      await control.command(
        'waitFor',
        `${activeTaskWorkbenchSelector} [data-testid="workspace-markdown-preview"]`,
        {
          text: FILE_PREVIEW_RESTORE_MARKER,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      assert.equal(
        await control.command(
          'getText',
          `${activeTaskWorkbenchSelector} [data-testid="workspace-file-path"]`
        ),
        join(workspacePath, GIT_SEED_NAME),
        'The linked absolute file path was lost after switching conversations'
      )
      await control.command('click', '[data-testid="right-workspace-browser-tab"]')
      await control.command('waitFor', activeBrowserInputSelector, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      assert.equal(
        await control.command('getValue', activeBrowserInputSelector),
        retainedBrowserUrl,
        'The Wework built-in browser URL was reset after switching conversations'
      )
      const restoredWorkspaceSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        restoredWorkspaceSnapshot.testIds.includes('right-workspace-browser-tab'),
        'The browser tab was not restored after switching conversations'
      )
      assert.ok(
        restoredWorkspaceSnapshot.testIds.includes('right-workspace-file-tab'),
        'The file tab was not restored after switching conversations'
      )
      assert.ok(
        restoredWorkspaceSnapshot.testIds.includes('right-workspace-review-tab'),
        'The review tab was not restored after switching conversations'
      )
      await control.command('finishAnimations', 'body')
      await captureVerificationScreenshot(control, 'workspace-panel-01-default-split.png')

      const expandedPanelToggleSelector =
        '[data-testid="toggle-right-workspace-panel-expanded-button"]'
      const rightPanelShellSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="right-workspace-panel-shell"]`
      await control.command('click', expandedPanelToggleSelector)
      await control.command(
        'waitFor',
        '[data-testid="restore-conversation-from-expanded-workspace-button"]',
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command('finishAnimations', 'body')
      assert.equal(
        await control.command('getInlineStyle', rightPanelShellSelector, { value: 'width' }),
        '100%',
        'The expanded right workspace panel did not occupy the full workbench width'
      )
      const expandedWorkspaceSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.equal(
        expandedWorkspaceSnapshot.testIds.includes('right-workspace-resize-handle'),
        false,
        'The right workspace resize handle remained visible while expanded'
      )
      assert.equal(
        expandedWorkspaceSnapshot.testIds.includes('project-chat-composer'),
        false,
        'The main composer remained visible while the non-chat workspace panel was expanded'
      )
      await captureVerificationScreenshot(control, 'workspace-panel-02-expanded.png')

      await control.command(
        'click',
        '[data-testid="restore-conversation-from-expanded-workspace-button"]'
      )
      await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('finishAnimations', 'body')
      await control.command('click', expandedPanelToggleSelector)
      await control.command(
        'waitFor',
        '[data-testid="restore-conversation-from-expanded-workspace-button"]',
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await control.command('finishAnimations', 'body')

      await control.command('toggleSidebar', '')
      await control.command('finishAnimations', 'body')
      const collapsedSidebarMetrics = await waitForElementWidth(
        control,
        '[data-testid="desktop-sidebar"]',
        width => width <= 1,
        'The desktop sidebar'
      )
      assert.ok(
        collapsedSidebarMetrics.width <= 1,
        'The desktop sidebar remained visible after it was collapsed'
      )
      assert.equal(
        await control.command('getInlineStyle', rightPanelShellSelector, { value: 'width' }),
        '100%',
        'The expanded right workspace panel changed width after the sidebar collapsed'
      )
      const sidebarHiddenPanelMetrics = await getSingleElementMetrics(
        control,
        rightPanelShellSelector,
        'The expanded right workspace panel'
      )
      const collapsedWorkbenchMetrics = await getSingleElementMetrics(
        control,
        ACTIVE_WORKBENCH_SELECTOR,
        'The collapsed workbench'
      )
      assert.ok(
        Math.abs(sidebarHiddenPanelMetrics.left - collapsedWorkbenchMetrics.left) <= 1,
        `The expanded right workspace panel was not aligned with the collapsed workbench: ${sidebarHiddenPanelMetrics.left}px versus ${collapsedWorkbenchMetrics.left}px`
      )
      await control.command('pointerLeave', '[data-testid="desktop-sidebar-hover-edge"]')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 350))
      await captureVerificationScreenshot(control, 'workspace-panel-03-expanded-sidebar-hidden.png')

      await control.command('toggleSidebar', '')
      await control.command('finishAnimations', 'body')
      await waitForElementWidth(
        control,
        '[data-testid="desktop-sidebar"]',
        width => width >= 239,
        'The desktop sidebar'
      )
      await control.command('click', expandedPanelToggleSelector)
      await control.command('waitFor', '[data-testid="right-workspace-resize-handle"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('finishAnimations', 'body')
      await captureVerificationScreenshot(control, 'workspace-panel-04-restored-split.png')
      await control.command('click', bottomWorkspaceTabCloseSelector)
      await control.command('click', rightBrowserTabCloseSelector)
      await control.command('click', '[data-testid="right-workspace-file-tab-close-button"]')
      await control.command('click', '[data-testid="right-workspace-review-tab-close-button"]')

      await control.command('fill', composerSelector, { value: '' })
      await control.command('click', `[data-testid="${secondTaskRowTestId}"]`)
      await control.command('fill', composerSelector, { value: '' })

      phase = 'background-completion-switch-and-reload'
      await verifyBackgroundCompletionRestore({
        composerSelector,
        control,
        otherTaskRowTestId: secondTaskRowTestId,
      })
      if (shouldStopAfterDesktopCheckpoint('conversation-state')) {
        console.log(`Wework desktop conversation-state checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('workspace-attachments')) {
      if (!taskRowTestId) {
        taskRowTestId = await createCheckpointTaskFixture(control, composerSelector)
        taskRowCompletionText = CHECKPOINT_TASK_COMPLETION_TEXT
      }
      phase = 'standalone-new-task-state'
      await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
      const standaloneTaskSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('project-work-button') &&
          (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
        'The task-section new-task action selected a project'
      )
      assert.ok(
        standaloneTaskSnapshot.testIds.includes('project-work-button'),
        'The standalone new task did not render the project selector'
      )

      await control.command('click', '[data-testid="new-chat-button"]')
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('project-work-button') &&
          (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
        'The global new-task action did not preserve the standalone project state'
      )

      phase = 'permanent-worktree-create'
      const sourceProjectId = projectId
      const sourceProjectMenuTestId = `project-menu-${sourceProjectId}`
      await control.command('waitFor', `[data-testid="${sourceProjectMenuTestId}"]`, {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await control.command('click', `[data-testid="${sourceProjectMenuTestId}"]`)
      await control.command('click', `[data-testid="create-permanent-worktree-${sourceProjectId}"]`)
      await control.command(
        'waitFor',
        `[data-testid="permanent-worktree-name-${sourceProjectId}"]`,
        {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        }
      )
      await control.command('fill', `[data-testid="permanent-worktree-name-${sourceProjectId}"]`, {
        value: 'Permanent E2E',
      })
      await control.command(
        'click',
        `[data-testid="confirm-create-permanent-worktree-${sourceProjectId}"]`
      )
      await waitForSnapshot(
        control,
        snapshot => snapshot.text.includes('Permanent E2E'),
        'The permanent worktree was not added to the project list'
      )
      const worktreeState = JSON.parse(
        await readFile(join(executorHome, 'runtime-work', 'worktrees.json'), 'utf8')
      )
      assert.equal(
        Object.values(worktreeState.records ?? {}).some(record => record.permanent === true),
        true,
        'The created worktree was not marked permanent'
      )

      phase = 'composer-project-create-and-new-chat'
      const projectRowsBeforeComposerCreate = new Set(
        (
          await waitForSnapshot(
            control,
            snapshot => snapshot.testIds.includes('project-work-button'),
            'The project selector was not ready for composer project creation'
          )
        ).testIds.filter(testId => testId.startsWith('project-row-'))
      )
      await control.command('click', '[data-testid="project-work-button"]')
      await control.command('click', '[data-testid="add-local-project-option"]')
      await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
      await waitForFolderPickerInitialized(control)
      await control.command('fill', '[data-testid="device-folder-path-input"]', {
        value: composerProjectPath,
      })
      await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
      await waitForFolderPathReady(control, composerProjectPath)
      await control.command(
        'clickWhenEnabled',
        '[data-testid="confirm-device-folder-picker-button"]',
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await confirmLocalProjectName(control, COMPOSER_PROJECT_NAME)
      const createdComposerProjectSnapshot = await waitForSnapshot(
        control,
        snapshot =>
          snapshot.text.includes(COMPOSER_PROJECT_NAME) &&
          snapshot.testIds.includes('project-work-button'),
        'The composer-created project was not selected after creation'
      )
      const createdComposerProjectRow = createdComposerProjectSnapshot.testIds.find(
        testId => testId.startsWith('project-row-') && !projectRowsBeforeComposerCreate.has(testId)
      )
      assert.ok(
        createdComposerProjectRow,
        'The composer-created project was not added to the sidebar'
      )

      await control.command('click', '[data-testid="runtime-chat-section-new-chat-button"]')
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes('project-work-button') &&
          (snapshot.text.includes('请选择项目') || snapshot.text.includes('Select project')),
        'The standalone new task did not clear the composer-created project'
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="${createdComposerProjectRow}"] [data-testid="project-new-conversation-button"]`
      )
      await control.command('waitFor', '[data-testid="project-work-button"]', {
        text: COMPOSER_PROJECT_NAME,
        stableMs: COMPOSER_READY_STABILITY_MS,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })

      phase = 'side-chat-attachment-isolation'
      await verifySideChatAttachmentIsolation({
        control,
        expectedCompletionText: taskRowCompletionText,
        taskRowTestId,
      })

      phase = 'attachment-only-sidebar'
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
      await verifyAttachmentOnlySidebarLifecycle({
        app,
        appIdentifier,
        composerSelector,
        control,
      })

      phase = 'pasted-zip-attachment'
      await verifyPastedZipAttachment({ composerSelector, control })

      phase = 'pasted-workspace-paths'
      await verifyPastedWorkspacePaths({ composerSelector, control, workspacePath })

      phase = 'dropped-workspace-paths'
      await verifyDroppedWorkspacePaths({ composerSelector, control, workspacePath })
      if (shouldStopAfterDesktopCheckpoint('workspace-attachments')) {
        console.log(
          `Wework desktop workspace-attachments checkpoint passed. Evidence: ${resultDir}`
        )
        return
      }
    }

    if (shouldRunDesktopCheckpoint('rendering-extensions')) {
      phase = 'tool-block-chronological-order'
      await verifyToolBlockChronologicalOrder({
        composerSelector,
        control,
      })

      phase = 'standalone-view-image'
      await verifyStandaloneViewImageTask({ composerSelector, control, projectRowSelector })

      if (desktopScenario) {
        phase = 'desktop-extension-scenario'
        desktopScenarioVerified = true
        await desktopScenario.verify(control)
      }
      if (shouldStopAfterDesktopCheckpoint('rendering-extensions')) {
        console.log(`Wework desktop rendering-extensions checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    if (shouldRunDesktopCheckpoint('embedded-browser')) {
      phase = 'embedded-browser-scenario'
      assert.ok(
        desktopScenario,
        'The embedded-browser checkpoint requires WEWORK_E2E_DESKTOP_SCENARIO_MODULE'
      )
      if (!desktopScenarioVerified) {
        desktopScenarioVerified = true
        await desktopScenario.verify(control)
      }
      if (shouldStopAfterDesktopCheckpoint('embedded-browser')) {
        console.log(`Wework desktop embedded-browser checkpoint passed. Evidence: ${resultDir}`)
        return
      }
    }

    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    console.log(`Wework desktop task-flow E2E passed. Diagnostics: ${resultDir}`)
  } catch (error) {
    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    await writeFile(
      join(resultDir, 'scenario-state.json'),
      `${JSON.stringify(
        {
          phase,
          scenario: control.scenario,
          modelStage: control.modelStage,
          localProtocolStates: Object.fromEntries(
            [...control.localProtocolStates.entries()].map(([protocol, state]) => [
              protocol,
              { stage: state.stage, requestCount: state.requests.length },
            ])
          ),
          desktopScenario: desktopScenario?.diagnostics?.() ?? null,
          cloudModelStage: control.cloudModelStage,
          matrixCase: control.matrixCase ? matrixCaseId(control.matrixCase) : null,
          matrixStage: control.matrixState?.stage ?? null,
          matrixRequestCount: control.matrixState?.requests.length ?? 0,
          scenarioRequestCounts: Object.fromEntries(
            [...control.scenarioRequests.entries()].map(([name, requests]) => [
              name,
              requests.length,
            ])
          ),
          httpRequests: control.httpRequests,
          commandHistory: control.commandHistory,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      join(resultDir, 'model-requests.json'),
      `${JSON.stringify(control.modelRequests, null, 2)}\n`,
      'utf8'
    )
    try {
      const snapshot = await control.command('snapshot', 'body', { timeoutMs: 5000 })
      await writeFile(join(resultDir, 'ui-snapshot.json'), `${snapshot}\n`, 'utf8')
    } catch {
      // Preserve the original test failure when the WebView can no longer answer diagnostics.
    }
    await writeFile(
      join(resultDir, 'failure.txt'),
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      'utf8'
    )
    throw error
  } finally {
    await cloudEnvironment?.stop()
    await blockingNetworkProxy?.stop()
    await stopDesktopAppProcess(app)
    await control.close()
    if (appBundlePath) {
      spawnSync(MACOS_LAUNCH_SERVICES_REGISTER, ['-u', appBundlePath])
    }
  }
}

main().then(
  () => process.stdout.write('', () => process.exit(0)),
  error => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${message}\n`, () => process.exit(1))
  }
)
