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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DESKTOP_CHECKPOINTS, PLUGIN_SEGMENTS } from '../checkpoints.mjs'
import { processIsAlive, stopProcess, stopProcessGroup } from '../process-lifecycle.mjs'
import { resolveDesktopE2EResultRoot } from '../result-retention.mjs'
import { loadDesktopScenario } from '../scenario-loader.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { sendPrompt } from './conversation-navigation.mjs'
import { waitForFolderPathReady, waitForFolderPickerInitialized } from './workspace-flows.mjs'

const WORKBENCH_READY_TIMEOUT_MS = 180_000
const DESKTOP_READY_TIMEOUT_MS = readPositiveTimeout(
  process.env.WEWORK_E2E_DESKTOP_READY_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  'WEWORK_E2E_DESKTOP_READY_TIMEOUT_MS'
)
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
const MODEL_PROTOCOL_MATRIX_TIMEOUT_MS = 120_000
const COMPOSER_READY_STABILITY_MS = 750
const DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS = readPositiveTimeout(
  process.env.WEWORK_E2E_CONTROL_DELIVERY_TIMEOUT_MS,
  30_000,
  'WEWORK_E2E_CONTROL_DELIVERY_TIMEOUT_MS'
)
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
const MCP_ELICITATION_PROMPT =
  'WEWORK_DESKTOP_E2E_MCP_ELICITATION: confirm the inner-site access audience.'
const MCP_ELICITATION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_MCP_ELICITATION_COMPLETE'
const MCP_ELICITATION_ACCEPTED_MARKER = 'E2E_MCP_ELICITATION_ACCEPTED:owner'
const MCP_ELICITATION_NAMESPACE = 'wegent_sites_interactions'
const MCP_ELICITATION_TOOL_NAME = 'confirm_inner_site_access'
const MCP_ELICITATION_SEARCH_ID = 'wework-e2e-mcp-elicitation-search'
const MCP_ELICITATION_CALL_ID = 'wework-e2e-mcp-elicitation-call'
const TASK_PLAN_PROMPT =
  'WEWORK_DESKTOP_E2E_TASK_PLAN: publish a task plan and finish after the task is backgrounded.'
const TASK_PLAN_STEP = 'Verify the background task plan remains visible'
const SEND_MODE_DRAFT = 'WEWORK_DESKTOP_E2E_SEND_MODE_DRAFT'
const QUEUED_FOLLOW_UP = 'WEWORK_DESKTOP_E2E_QUEUED_FOLLOW_UP'
const BACKGROUND_GUIDANCE = 'WEWORK_DESKTOP_E2E_BACKGROUND_GUIDANCE'
const BACKGROUND_GUIDANCE_CONTINUATION = 'WEWORK_DESKTOP_E2E_BACKGROUND_GUIDANCE_CONTINUATION'
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
const EMBEDDED_BROWSER_SETUP_PROMPT =
  'WEWORK_DESKTOP_E2E_EMBEDDED_BROWSER_SETUP: create a local task before opening the browser.'
const EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_EMBEDDED_BROWSER_SETUP_COMPLETE'
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
const GOAL_BUSY_PLAN_PROMPT =
  'WEWORK_DESKTOP_E2E_GOAL_BUSY_PLAN: keep this planning turn open while Goal is enabled.'
const GOAL_BUSY_PLAN_TEXT = 'WEWORK_DESKTOP_E2E_GOAL_BUSY_PLAN_COMPLETE'
const GOAL_BUSY_OBJECTIVE =
  'WEWORK_DESKTOP_E2E_GOAL_BUSY_OBJECTIVE: start automatically after the planning turn.'
const GOAL_BUSY_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_GOAL_BUSY_COMPLETE'
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
const MESSAGE_EDIT_ORIGINAL_PROMPT =
  'WEWORK_DESKTOP_E2E_MESSAGE_EDIT_ORIGINAL: answer before this message is edited.'
const MESSAGE_EDIT_ORIGINAL_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_MESSAGE_EDIT_ORIGINAL_COMPLETE'
const MESSAGE_EDIT_UPDATED_PROMPT =
  'WEWORK_DESKTOP_E2E_MESSAGE_EDIT_UPDATED: answer only this edited message.'
const MESSAGE_EDIT_UPDATED_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_MESSAGE_EDIT_UPDATED_COMPLETE'
const FILE_PANEL_ANCHOR_PROMPT =
  'WEWORK_DESKTOP_E2E_FILE_PANEL_ANCHOR: create a long response with a file link in the middle.'
const FILE_PANEL_ANCHOR_MARKER = 'WEWORK_DESKTOP_E2E_FILE_PANEL_ANCHOR_MARKER'
const FILE_PANEL_LINK_NAME = 'README file.md'
const FILE_PREVIEW_RESTORE_MARKER = 'WEWORK_DESKTOP_E2E_FILE_PREVIEW_RESTORED'
const REVIEW_RESTORE_MARKER = 'WEWORK_DESKTOP_E2E_REVIEW_RESTORED'
const FILE_PANEL_ANCHOR_RESPONSE = [
  'WEWORK_DESKTOP_E2E_FILE_PANEL_ANCHOR_RESPONSE',
  ...Array.from({ length: 30 }, (_, index) =>
    index === 14
      ? `${FILE_PANEL_ANCHOR_MARKER}: inspect [${FILE_PANEL_LINK_NAME}](${FILE_PANEL_LINK_NAME.replaceAll(' ', '%20')}:1) without moving this paragraph.`
      : `File panel anchor paragraph ${String(index + 1).padStart(2, '0')}. ${'Scrollable anchor content '.repeat(8)}`
  ),
].join('\n\n')
const TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX = 'WEWORK_DESKTOP_E2E_TURN_NAVIGATION'
const TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX = 'WEWORK_DESKTOP_E2E_TURN_NAVIGATION_COMPLETE'
const E2E_TRANSCRIPT_PAGE_SIZE = 20
const TURN_NAVIGATION_REGRESSION_TURN_COUNT = 30
const TURN_NAVIGATION_ONLY_TURN_COUNT = 55
const TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN = 6
const CANCELLATION_PROMPT = 'WEWORK_DESKTOP_E2E_CANCEL: wait until the response is cancelled.'
const CANCELLATION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_CANCEL_COMPLETE'
const SEND_REJECTION_RUNNING_PROMPT =
  'WEWORK_DESKTOP_E2E_SEND_REJECTION_RUNNING: keep this turn active.'
const SEND_REJECTION_RETRY_PROMPT =
  'WEWORK_DESKTOP_E2E_SEND_REJECTION_RETRY: queue this send after stale idle state.'
const SEND_REJECTION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_SEND_REJECTION_COMPLETE'
const RETRY_PROMPT = 'WEWORK_DESKTOP_E2E_RETRY: fail once and then succeed after retry.'
const RETRY_CONTINUATION_PROMPT =
  'Continue the unfinished work from the previous turn. Use the existing conversation context and do not repeat work that is already complete.'
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
const CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB ?? 384 * 1024
)
const CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB ?? 320 * 1024
)
const CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB = Number(
  process.env.WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB ?? 64 * 1024
)
const MEMORY_SAMPLE_INTERVAL_MS = 500
const MEMORY_MAX_PEAK_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB ?? 384 * 1024
)
const MEMORY_MAX_SETTLED_GROWTH_KIB = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB ?? 232 * 1024
)
const MEMORY_MAX_SETTLED_DOM_NODE_GROWTH = Number(
  process.env.WEWORK_E2E_MEMORY_MAX_SETTLED_DOM_NODE_GROWTH ?? 512
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
const LOCAL_MARKDOWN_IMAGE_PROMPT =
  'WEWORK_DESKTOP_E2E_LOCAL_MARKDOWN_IMAGE: render the temporary image.'
const LOCAL_MARKDOWN_IMAGE_FILENAME = `wework-e2e-assistant-markdown-image-${randomUUID()}.png`
const LOCAL_MARKDOWN_IMAGE_ALT = 'WEWORK_DESKTOP_E2E_LOCAL_MARKDOWN_IMAGE_ALT'
const VISION_SIDECAR_PROMPT =
  'WEWORK_DESKTOP_E2E_VISION_SIDECAR: describe the attached verification image.'
const VISION_SIDECAR_DESCRIPTION = 'The verification image is a solid red square.'
const VISION_SIDECAR_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_VISION_SIDECAR_COMPLETE'
const VISION_SIDECAR_MAIN_REQUEST_SCENARIO = 'vision_sidecar_main'
const MULTIMODAL_VISION_PROMPT =
  'WEWORK_DESKTOP_E2E_MULTIMODAL_VISION: inspect the attached verification image.'
const MULTIMODAL_VISION_COMPLETION_TEXT = 'WEWORK_DESKTOP_E2E_MULTIMODAL_VISION_COMPLETE'
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
  mainLabel: 'Desktop E2E DeepSeek Flash Vision Main',
  mainModelId: 'deepseek-v4-flash',
  sidecarModelId: 'desktop-e2e-cloud-vision-sidecar-upstream',
}
const CLOUD_MULTIMODAL_VISION_CASE = {
  source: 'cloud-multimodal',
  mainOptionId: 'desktop-e2e-cloud-multimodal-vision',
  mainLabel: 'Desktop E2E Cloud Multimodal Vision',
  mainModelId: 'desktop-e2e-cloud-multimodal-vision-upstream',
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
    optionIds: ['wework-custom-desktop-e2e-responses', 'local-model:desktop-e2e-responses'],
    labels: ['wework-custom-desktop-e2e-responses', 'Desktop E2E Responses'],
    modelId: 'desktop-e2e-responses-model',
  },
  {
    protocol: 'chat',
    optionIds: ['wework-custom-desktop-e2e-chat', 'local-model:desktop-e2e-chat'],
    labels: ['wework-custom-desktop-e2e-chat', 'Desktop E2E Chat'],
    modelId: 'desktop-e2e-chat-model',
  },
  {
    protocol: 'anthropic',
    optionIds: ['wework-custom-desktop-e2e-anthropic', 'local-model:desktop-e2e-anthropic'],
    labels: ['wework-custom-desktop-e2e-anthropic', 'Desktop E2E Anthropic'],
    modelId: 'desktop-e2e-anthropic-model',
  },
]
const MODEL_PROTOCOLS = ['responses', 'chat', 'anthropic']
const CLOUD_MODEL_CASES = MODEL_PROTOCOLS.map(protocol => ({
  source: 'cloud',
  protocol,
  optionIds: [`desktop-e2e-cloud-${protocol}`],
  labels: [protocol === 'chat' ? 'moonshot-kimi-k3' : `desktop-e2e-cloud-${protocol}`],
  modelId: protocol === 'chat' ? 'moonshot-kimi-k3' : `desktop-e2e-cloud-${protocol}-upstream`,
}))
const MODEL_PROTOCOL_MATRIX_CASES = [
  ...LOCAL_MODEL_CASES.map(model => ({ ...model, source: 'local' })),
  ...MODEL_PROTOCOLS.map(protocol => ({
    source: 'codex',
    protocol,
    optionIds: [DEFAULT_MODEL_ID],
    labels: [DEFAULT_MODEL_LABEL],
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
const PROVIDER_SWITCH_LUNA_OPTION_IDS = [
  'wework-custom-desktop-e2e-luna-overseas',
  'local-model:desktop-e2e-luna-overseas',
]
const PROVIDER_SWITCH_LUNA_LABELS = [
  'wework-custom-desktop-e2e-luna-overseas',
  'GPT 5.6 Luna (海外)',
]
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
const PROVIDER_SWITCH_RESUME_PROMPT =
  'WEWORK_DESKTOP_E2E_PROVIDER_SWITCH_RESUME: continue the loaded official thread with Luna.'
const PROVIDER_SWITCH_RESUME_COMPLETION = 'WEWORK_DESKTOP_E2E_PROVIDER_SWITCH_RESUME_LUNA_COMPLETE'
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
const REMOTE_DOCKER_DEVICE_ID = 'wework-e2e-remote-docker-device'
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
const SIDE_CHAT_QUEUE_FOLLOW_UP = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_QUEUE_FOLLOW_UP'
const SIDE_CHAT_GUIDANCE_INITIAL = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_GUIDANCE_INITIAL'
const SIDE_CHAT_GUIDANCE_FOLLOW_UP = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_GUIDANCE_FOLLOW_UP'
const SIDE_CHAT_GUIDANCE_COMPLETION = 'WEWORK_DESKTOP_E2E_SIDE_CHAT_GUIDANCE_COMPLETE'
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
const GOAL_BUSY_ONLY = process.argv.includes('--goal-busy-only')
const GOAL_RESTART_ONLY = process.argv.includes('--goal-restart-only')
const TURN_NAVIGATION_ONLY = process.argv.includes('--turn-navigation-only')
const ATTACHMENT_ONLY = process.argv.includes('--attachment-only')
const PASTED_WORKSPACE_PATHS_ONLY = process.argv.includes('--pasted-workspace-paths-only')
const DROPPED_WORKSPACE_PATHS_ONLY = process.argv.includes('--dropped-workspace-paths-only')
const SYSTEM_DRAG_PANEL_ONLY = process.argv.includes('--system-drag-panel-only')
const MODEL_SWITCH_ONLY = process.argv.includes('--model-switch-only')
const CLOUD_ONLY = process.argv.includes('--cloud-only')
const CLOUD_FEATURES_ONLY = process.argv.includes('--cloud-features-only')
const CLOUD_VISION_ONLY = process.argv.includes('--cloud-vision-only')
const PLUGINS_ONLY = process.argv.includes('--plugins-only')
const AUTOMATION_ONLY = process.argv.includes('--automation-only')
const MEMORY_ONLY = process.argv.includes('--memory-only')
const WORKTREE_STATUS_ONLY = process.argv.includes('--worktree-status-only')
const TOOL_BLOCK_ORDER_ONLY = process.argv.includes('--tool-block-order-only')
const QUEUE_NAVIGATION_ONLY = process.argv.includes('--queue-navigation-only')
const GUIDANCE_BACKGROUND_ONLY = process.argv.includes('--guidance-background-only')
const GUIDANCE_SCROLL_ONLY = process.argv.includes('--guidance-scroll-only')
const MESSAGE_RESTORATION_ONLY = process.argv.includes('--message-restoration-only')
const MESSAGE_EDIT_ONLY = process.argv.includes('--message-edit-only')
const QUEUE_MANAGEMENT_ONLY = process.argv.includes('--queue-management-only')
const SEND_REJECTION_ONLY = process.argv.includes('--send-rejection-only')
const TASK_PLAN_ONLY = process.argv.includes('--task-plan-only')
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
const weworkDir = resolve(scriptDir, '..', '..', '..')
const repoDir = resolve(weworkDir, '..')
const toolDetailsMcpServerPath = join(weworkDir, 'e2e', 'utils', 'tool-details-mcp-server.mjs')
const mcpElicitationServerPath = join(weworkDir, 'e2e', 'utils', 'mcp-elicitation-server.mjs')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const resultRoot = resolveDesktopE2EResultRoot(weworkDir)
const resultDir = join(resultRoot, runId)

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
const OFFICIAL_PLUGIN_MCP_SEARCH_ID = 'wework-e2e-search-official-plugin-mcp'
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
    ['--goal-busy-only', GOAL_BUSY_ONLY],
    ['--goal-restart-only', GOAL_RESTART_ONLY],
    ['--turn-navigation-only', TURN_NAVIGATION_ONLY],
    ['--attachment-only', ATTACHMENT_ONLY],
    ['--pasted-workspace-paths-only', PASTED_WORKSPACE_PATHS_ONLY],
    ['--dropped-workspace-paths-only', DROPPED_WORKSPACE_PATHS_ONLY],
    ['--system-drag-panel-only', SYSTEM_DRAG_PANEL_ONLY],
    ['--model-switch-only', MODEL_SWITCH_ONLY],
    ['--cloud-only', CLOUD_ONLY],
    ['--cloud-features-only', CLOUD_FEATURES_ONLY],
    ['--cloud-vision-only', CLOUD_VISION_ONLY],
    ['--plugins-only', PLUGINS_ONLY],
    ['--automation-only', AUTOMATION_ONLY],
    ['--memory-only', MEMORY_ONLY],
    ['--worktree-status-only', WORKTREE_STATUS_ONLY],
    ['--tool-block-order-only', TOOL_BLOCK_ORDER_ONLY],
    ['--queue-navigation-only', QUEUE_NAVIGATION_ONLY],
    ['--guidance-background-only', GUIDANCE_BACKGROUND_ONLY],
    ['--guidance-scroll-only', GUIDANCE_SCROLL_ONLY],
    ['--message-restoration-only', MESSAGE_RESTORATION_ONLY],
    ['--message-edit-only', MESSAGE_EDIT_ONLY],
    ['--queue-management-only', QUEUE_MANAGEMENT_ONLY],
    ['--send-rejection-only', SEND_REJECTION_ONLY],
    ['--task-plan-only', TASK_PLAN_ONLY],
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

async function commandOutputAsync(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolvePromise(stdout.trim())
        return
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${code ?? 'unknown status'}: ${stderr || stdout}`
        )
      )
    })
  })
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

  release() {
    if (this.released) return
    this.released = true
    for (const socket of this.sockets) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
  }

  block() {
    this.released = false
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

function macosSleepAssertionIds(appProcessId) {
  if (process.platform !== 'darwin') return []
  const output = commandOutput('/usr/bin/pmset', ['-g', 'assertions'])
  return output.split('\n').flatMap(line => {
    const match = line
      .trim()
      .match(/^pid (\d+)\([^)]+\): \[(0x[0-9a-f]+)\].*NoIdleSleepAssertion named: "Electron"/i)
    if (!match || Number(match[1]) !== appProcessId) {
      return []
    }
    return [match[2]]
  })
}

async function waitForMacosSleepAssertion(appProcessId, expectedRunning) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const assertionIds = macosSleepAssertionIds(appProcessId)
    if (assertionIds.length > 0 === expectedRunning) return assertionIds
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(
    `Timed out waiting for the macOS sleep assertion to be ${expectedRunning ? 'active' : 'released'}`
  )
}

async function waitForExecutorRuntimeEvidence(
  control,
  _logPath,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  minimumProcessCount = 1
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const diagnostics = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
    const executorProcessId = Number(diagnostics.executorPid)
    if (Number.isInteger(executorProcessId) && executorProcessId > 0) {
      return {
        processIds: [executorProcessId],
        content: JSON.stringify(diagnostics),
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('Timed out waiting for the Electron core runtime executor process')
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

async function reactivateMacApplication(appIdentifier, appBundlePath = null) {
  if (appBundlePath) {
    await runChecked('open', ['-g', appBundlePath])
    return
  }
  await runChecked('open', ['-g', '-b', appIdentifier])
}

function requestMacosApplicationQuit(processId) {
  commandOutput('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${processId}); app ? Boolean(app.terminate) : false`,
  ])
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

function modelProviderSelector(providerId) {
  return providerId ? `[data-model-provider-id="${providerId}"]` : ''
}

async function visibleModelOptionId(control, targetOptionIds, providerId) {
  for (const targetOptionId of targetOptionIds) {
    const targetSelector = `[data-testid="model-selector-submenu"] [data-testid="${targetOptionId}"]${modelProviderSelector(providerId)}`
    await control.command('scrollIntoView', targetSelector).catch(() => undefined)
    const visibleCount = await control
      .command('getElementCount', targetSelector, { visible: true })
      .then(value => Number(value))
      .catch(() => 0)
    if (visibleCount > 0) {
      return targetOptionId
    }
  }
  return null
}

async function revealGroupedModelOption(control, targetOptionIds, providerId) {
  const menu = JSON.parse(await control.command('snapshot', 'body'))
  if (await visibleModelOptionId(control, targetOptionIds, providerId)) return true
  const familyTestIds = menu.testIds.filter(testId => testId.startsWith('model-family-'))

  for (const familyTestId of familyTestIds) {
    await control.command('hover', `[data-testid="${familyTestId}"]`, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
    if (await visibleModelOptionId(control, targetOptionIds, providerId)) return true
  }

  return false
}

function modelOptionIdCandidates(modelIds) {
  return (Array.isArray(modelIds) ? modelIds : [modelIds]).map(modelId =>
    modelId.startsWith('model-option-') ? modelId : `model-option-${modelId}`
  )
}

function expectedModelProviderId(modelIds) {
  const targetOptionIds = modelOptionIdCandidates(modelIds)
  return targetOptionIds.includes(`model-option-${DEFAULT_MODEL_ID}`)
    ? MODEL_PROVIDER_ID
    : undefined
}

function hasModelOption(menu, targetOptionIds) {
  return targetOptionIds.some(targetOptionId => menu.testIds.includes(targetOptionId))
}

async function hasExpectedModelOption(control, menu, targetOptionIds, expectedProviderId) {
  if (!expectedProviderId) return hasModelOption(menu, targetOptionIds)
  return Boolean(await visibleModelOptionId(control, targetOptionIds, expectedProviderId))
}

async function ensureModelOptionVisible(
  control,
  modelIds,
  modelSelectorButton = '[data-testid="model-selector-button"]',
  expectedProviderId = expectedModelProviderId(modelIds)
) {
  const targetOptionIds = modelOptionIdCandidates(modelIds)
  let reloadedLocalModels = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let menu = JSON.parse(await control.command('snapshot', 'body'))
    if (await hasExpectedModelOption(control, menu, targetOptionIds, expectedProviderId))
      return menu
    if (menu.testIds.includes('model-control-menu-model')) {
      await control
        .command('hover', '[data-testid="model-control-menu-model"]', {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        })
        .catch(() => undefined)
    } else {
      await control
        .command('hover', modelSelectorButton, {
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          visible: true,
        })
        .catch(() => undefined)
      menu = JSON.parse(await control.command('snapshot', 'body'))
      if (!menu.testIds.includes('model-selector-menu')) {
        await control.command('clickWhenEnabled', modelSelectorButton, {
          stableMs: 100,
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
          visible: true,
        })
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
    menu = JSON.parse(await control.command('snapshot', 'body'))
    if (await hasExpectedModelOption(control, menu, targetOptionIds, expectedProviderId))
      return menu
    if (await revealGroupedModelOption(control, targetOptionIds, expectedProviderId)) {
      return JSON.parse(await control.command('snapshot', 'body'))
    }
    if (expectedProviderId && !reloadedLocalModels) {
      await control.command('dispatchLocalModelSettingsChanged', '')
      reloadedLocalModels = true
    }
  }

  throw new Error(
    `Model options ${targetOptionIds.join(', ')} did not become visible${expectedProviderId ? ` for provider ${expectedProviderId}` : ''}`
  )
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

async function createSingleRootLocalProject(
  control,
  workspacePath,
  name,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const sidebarSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('projects-empty-create-button') ||
      snapshot.testIds.includes('runtime-project-sortable-list'),
    'The project section did not settle into an empty or populated state',
    timeoutMs
  )
  const createButtonSelector = sidebarSnapshot.testIds.includes('projects-empty-create-button')
    ? '[data-testid="projects-empty-create-button"]'
    : '[data-testid="projects-create-button"]'
  if (createButtonSelector.includes('projects-empty-create-button')) {
    assert.match(
      await control.command('getText', createButtonSelector),
      /New project|新建项目/,
      'The empty project section did not expose a localized creation action'
    )
  }
  await control.command('click', createButtonSelector)
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
  modelIds = DEFAULT_MODEL_ID,
  modelLabels = DEFAULT_MODEL_LABEL,
  composerSelector = ''
) {
  const labels = Array.isArray(modelLabels) ? modelLabels : [modelLabels]
  const expectedProviderId = expectedModelProviderId(modelIds)
  const modelSelectorButton = `${composerSelector} [data-testid="model-selector-button"]`.trim()
  await control.command('waitFor', modelSelectorButton, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    visible: true,
  })
  const selectedModelLabel = await control.command('getText', modelSelectorButton, {
    visible: true,
  })
  const selectedProviderId = await control.command('getAttribute', modelSelectorButton, {
    value: 'data-model-provider-id',
  })
  if (
    labels.some(label => selectedModelLabel.includes(label)) &&
    (!expectedProviderId || selectedProviderId === expectedProviderId)
  ) {
    return
  }

  await ensureModelOptionVisible(control, modelIds, modelSelectorButton, expectedProviderId)
  const targetOptionIds = modelOptionIdCandidates(modelIds)
  let targetOptionId = await visibleModelOptionId(control, targetOptionIds, expectedProviderId)
  if (!targetOptionId) {
    const menu = JSON.parse(await control.command('snapshot', 'body'))
    if (!menu.testIds.includes('model-selector-menu')) {
      await control.command('clickWhenEnabled', modelSelectorButton, {
        stableMs: 100,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        visible: true,
      })
    }
    await revealGroupedModelOption(control, targetOptionIds, expectedProviderId)
    targetOptionId = await visibleModelOptionId(control, targetOptionIds, expectedProviderId)
  }
  assert.ok(targetOptionId, `No visible model option matched ${modelOptionIdCandidates(modelIds)}`)
  const targetSelector = `[data-testid="model-selector-submenu"] [data-testid="${targetOptionId}"]${modelProviderSelector(expectedProviderId)}`
  await control.command('waitFor', targetSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', targetSelector)
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
  await waitForE2EModelLabel(control, labels, modelSelectorButton)
  if (expectedProviderId) {
    assert.equal(
      await control.command('getAttribute', modelSelectorButton, {
        value: 'data-model-provider-id',
      }),
      expectedProviderId,
      'The model selector did not retain the expected provider'
    )
  }
  await control.command('press', 'body', { key: 'Escape' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('model-selector-menu'),
    'The model selector menu did not close after selecting the E2E model'
  )
}

async function waitForE2EModelLabel(
  control,
  labels,
  modelSelectorButton = '[data-testid="model-selector-button"]'
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const selectedModelLabel = await control.command('getText', modelSelectorButton, {
      visible: true,
    })
    if (labels.some(label => selectedModelLabel.includes(label))) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Model selector did not display one of: ${labels.join(', ')}`)
}

export {
  assert,
  randomUUID,
  spawn,
  spawnSync,
  createServer,
  createTcpServer,
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
  constants,
  dirname,
  join,
  relative,
  resolve,
  fileURLToPath,
  pathToFileURL,
  DESKTOP_CHECKPOINTS,
  PLUGIN_SEGMENTS,
  loadDesktopScenario,
  stopProcess,
  stopProcessGroup,
  DESKTOP_READY_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DESKTOP_MODEL_SERVER_PORT,
  DESKTOP_CONTROL_SERVER_PORT,
  MODEL_PROTOCOL_MATRIX_TIMEOUT_MS,
  COMPOSER_READY_STABILITY_MS,
  DESKTOP_CONTROL_DELIVERY_TIMEOUT_MS,
  DESKTOP_CONTROL_RESULT_GRACE_MS,
  QUEUE_MANAGEMENT_REQUEST_TIMEOUT_MS,
  readPositiveTimeout,
  readOptionalPort,
  TASK_PROMPT,
  COMPLETION_TEXT,
  FOLLOW_UP_PROMPT,
  FOLLOW_UP_COMPLETION_TEXT,
  RUNNING_FORK_FOLLOW_UP_PROMPT,
  RUNNING_FORK_COMPLETION_TEXT,
  FORK_FOLLOW_UP_PROMPT,
  FORK_FOLLOW_UP_COMPLETION_TEXT,
  FORK_ENCRYPTED_CONTENT,
  REQUEST_USER_INPUT_PROMPT,
  REQUEST_USER_INPUT_QUESTION,
  REQUEST_USER_INPUT_COMPLETION_TEXT,
  MCP_ELICITATION_PROMPT,
  MCP_ELICITATION_COMPLETION_TEXT,
  MCP_ELICITATION_ACCEPTED_MARKER,
  MCP_ELICITATION_NAMESPACE,
  MCP_ELICITATION_TOOL_NAME,
  MCP_ELICITATION_SEARCH_ID,
  MCP_ELICITATION_CALL_ID,
  TASK_PLAN_PROMPT,
  TASK_PLAN_STEP,
  SEND_MODE_DRAFT,
  QUEUED_FOLLOW_UP,
  BACKGROUND_GUIDANCE,
  BACKGROUND_GUIDANCE_CONTINUATION,
  GUIDANCE_SCROLL_PROMPT,
  GUIDANCE_SCROLL_ACTIVE_PROMPT,
  GUIDANCE_SCROLL_RESPONSE,
  GUIDANCE_SCROLL_MESSAGE,
  GUIDANCE_SCROLL_PRE_TOOL_TEXT,
  GUIDANCE_SCROLL_COMPLETION_TEXT,
  EMBEDDED_BROWSER_SETUP_PROMPT,
  EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT,
  QUEUE_DIRECT_INITIAL,
  QUEUE_DIRECT_FIRST,
  QUEUE_DIRECT_SECOND,
  QUEUE_DIRECT_THIRD,
  QUEUE_PRESERVE_INITIAL,
  QUEUE_PRESERVE_QUEUED,
  QUEUE_PRESERVE_MANUAL,
  QUEUE_CLEAR_INITIAL,
  QUEUE_CLEAR_QUEUED,
  QUEUE_CLEAR_MANUAL,
  QUEUE_MANAGEMENT_COMPLETION_PREFIX,
  UNSENT_BLANK_TASK_DRAFT,
  UNSENT_FIRST_TASK_DRAFT,
  UNSENT_SECOND_TASK_DRAFT,
  WINDOW_LIFECYCLE_PROMPT,
  WINDOW_LIFECYCLE_COMPLETION_TEXT,
  BACKGROUND_COMPLETION_RESTORE_PROMPT,
  BACKGROUND_COMPLETION_RESTORE_TEXT,
  BACKGROUND_FOLLOW_UP_RESTORE_PROMPT,
  BACKGROUND_FOLLOW_UP_RESTORE_TEXT,
  WINDOW_LIFECYCLE_SCROLL_MARKER,
  GOAL_IDLE_PROMPT,
  GOAL_IDLE_INITIAL_TEXT,
  GOAL_IDLE_COMPLETION_TEXT,
  GOAL_BUSY_PLAN_PROMPT,
  GOAL_BUSY_PLAN_TEXT,
  GOAL_BUSY_OBJECTIVE,
  GOAL_BUSY_COMPLETION_TEXT,
  GOAL_RESTART_PROMPT,
  GOAL_RESTART_INITIAL_TEXT,
  GOAL_RESTART_RESUME_PROMPT,
  GOAL_RESTART_COMPLETION_TEXT,
  SUPERVISOR_PROMPT,
  SUPERVISOR_COMPLETION_TEXT,
  SUPERVISOR_PRINCIPLES,
  SUPERVISOR_CORRECTION,
  SUPERVISOR_CORRECTION_COMPLETION_TEXT,
  WINDOW_LIFECYCLE_COMPLETION_RESPONSE,
  CHECKPOINT_TASK_PROMPT,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  MESSAGE_EDIT_ORIGINAL_PROMPT,
  MESSAGE_EDIT_ORIGINAL_COMPLETION_TEXT,
  MESSAGE_EDIT_UPDATED_PROMPT,
  MESSAGE_EDIT_UPDATED_COMPLETION_TEXT,
  FILE_PANEL_ANCHOR_PROMPT,
  FILE_PANEL_ANCHOR_MARKER,
  FILE_PANEL_LINK_NAME,
  FILE_PREVIEW_RESTORE_MARKER,
  REVIEW_RESTORE_MARKER,
  FILE_PANEL_ANCHOR_RESPONSE,
  TURN_NAVIGATION_REGRESSION_PROMPT_PREFIX,
  TURN_NAVIGATION_REGRESSION_COMPLETION_PREFIX,
  E2E_TRANSCRIPT_PAGE_SIZE,
  TURN_NAVIGATION_REGRESSION_TURN_COUNT,
  TURN_NAVIGATION_ONLY_TURN_COUNT,
  TURN_NAVIGATION_VIRTUALIZED_BOUNDARY_TURN,
  CANCELLATION_PROMPT,
  CANCELLATION_COMPLETION_TEXT,
  SEND_REJECTION_RUNNING_PROMPT,
  SEND_REJECTION_RETRY_PROMPT,
  SEND_REJECTION_COMPLETION_TEXT,
  RETRY_PROMPT,
  RETRY_CONTINUATION_PROMPT,
  RETRY_FAILURE_TEXT,
  RETRY_CODEX_ERROR_TEXT,
  RETRY_COMPLETION_TEXT,
  RATE_LIMIT_PROMPT,
  RATE_LIMIT_COMPLETION_TEXT,
  ANTHROPIC_EMPTY_PROMPT,
  ANTHROPIC_EMPTY_COMPLETION_TEXT,
  RECONNECT_PROMPT,
  RECONNECT_COMPLETION_TEXT,
  MEMORY_PROMPT,
  MEMORY_COMPLETION_TEXT,
  CONCURRENT_MEMORY_TASK_COUNT,
  CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB,
  CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB,
  CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB,
  MEMORY_SAMPLE_INTERVAL_MS,
  MEMORY_MAX_PEAK_GROWTH_KIB,
  MEMORY_MAX_SETTLED_GROWTH_KIB,
  MEMORY_MAX_SETTLED_DOM_NODE_GROWTH,
  MEMORY_MIN_BASELINE_SAMPLES,
  MEMORY_MAX_BASELINE_SAMPLES,
  MEMORY_MIN_SETTLED_SAMPLES,
  MEMORY_MAX_SETTLED_SAMPLES,
  MEMORY_MAX_SAMPLE_RANGE_KIB,
  MEMORY_SAMPLE_WINDOW_SIZE,
  ARTIFACT_NAME,
  ARTIFACT_CONTENT,
  IMAGE_ARTIFACT_NAME,
  VIEW_IMAGE_PROMPT,
  VIEW_IMAGE_COMPLETION_TEXT,
  LOCAL_MARKDOWN_IMAGE_PROMPT,
  LOCAL_MARKDOWN_IMAGE_FILENAME,
  LOCAL_MARKDOWN_IMAGE_ALT,
  VISION_SIDECAR_PROMPT,
  VISION_SIDECAR_DESCRIPTION,
  VISION_SIDECAR_COMPLETION_TEXT,
  VISION_SIDECAR_MAIN_REQUEST_SCENARIO,
  MULTIMODAL_VISION_PROMPT,
  MULTIMODAL_VISION_COMPLETION_TEXT,
  LOCAL_VISION_SIDECAR_CASE,
  CLOUD_VISION_SIDECAR_CASE,
  CLOUD_MULTIMODAL_VISION_CASE,
  IMAGE_ARTIFACT_BASE64,
  GIT_SEED_NAME,
  GIT_SEED_CONTENT,
  MODEL_API_KEY,
  MODEL_PROVIDER_ID,
  CUSTOM_TOOL_INPUT_DESCRIPTION,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  LOCAL_MODEL_CASES,
  MODEL_PROTOCOLS,
  CLOUD_MODEL_CASES,
  MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_MODEL_SWITCH_CASES,
  LOCAL_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
  CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  MIXED_TOOL_TURN_MODEL_PROTOCOL_MATRIX_CASES,
  LOCAL_CONNECTED_MODEL_PROTOCOL_MATRIX_CASES,
  MODEL_PROTOCOL_MATRIX_TOTAL,
  MODEL_PROTOCOL_MATRIX_TEXT_PREFIX,
  MODEL_PROTOCOL_MATRIX_TOOL_PREFIX,
  LOCAL_MODEL_SWITCH_INITIAL_PROMPT,
  LOCAL_MODEL_SWITCH_INITIAL_COMPLETE,
  LOCAL_MODEL_SWITCH_FOLLOW_UP_PROMPT,
  LOCAL_MODEL_SWITCH_COMPLETE,
  LOCAL_MODEL_SWITCH_INVALID_CALL_ID,
  LOCAL_MODEL_SWITCH_ARTIFACT,
  LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
  PROVIDER_SWITCH_LUNA_OPTION_IDS,
  PROVIDER_SWITCH_LUNA_LABELS,
  PROVIDER_SWITCH_LUNA_MODEL_ID,
  PROVIDER_SWITCH_OFFICIAL_OPTION_ID,
  PROVIDER_SWITCH_OFFICIAL_LABEL,
  PROVIDER_SWITCH_OFFICIAL_MODEL_ID,
  PROVIDER_SWITCH_OFFICIAL_MODEL_LABEL,
  PROVIDER_SWITCH_PROMPT,
  PROVIDER_SWITCH_FAILURE,
  PROVIDER_SWITCH_COMPLETION,
  PROVIDER_SWITCH_RESUME_PROMPT,
  PROVIDER_SWITCH_RESUME_COMPLETION,
  BLOCKED_CLOUD_MODEL_PATH,
  TELEMETRY_CAPTURE_PATH,
  TELEMETRY_TEST_PROJECT_KEY,
  TELEMETRY_SAFE_PROPERTY_KEYS,
  TELEMETRY_FORBIDDEN_PROPERTY_PATTERN,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_LABEL,
  CLOUD_DEVICE_ID,
  REMOTE_DOCKER_DEVICE_ID,
  FRESH_CHAT_PROMPT,
  FRESH_CHAT_COMPLETION_TEXT,
  CONVERSATION_SWITCH_RACE_PROMPT,
  SHORT_CONVERSATION_MAX_MESSAGE_TOP_OFFSET,
  COMPOSER_PROJECT_NAME,
  ATTACHMENT_ONLY_COMPLETION_TEXT,
  ATTACHMENT_ONLY_FILENAME,
  PASTED_ZIP_FILENAME,
  PASTED_ZIP_COMPLETION_TEXT,
  PASTED_ZIP_BASE64,
  PASTED_PATH_FOLDER_NAME,
  PASTED_PATH_FILE_NAME,
  PASTED_PATH_COMPLETION_TEXT,
  DROPPED_PATH_FOLDER_NAME,
  DROPPED_PATH_FILE_NAME,
  DROPPED_PATH_COMPLETION_TEXT,
  TOOL_BLOCK_ORDER_PROMPT,
  TOOL_BLOCK_ORDER_COMPLETION_TEXT,
  EARLIER_TOOL_BLOCK_ID,
  NODE_REPL_TOOL_SEARCH_ID,
  NODE_REPL_TOOL_BLOCK_ID,
  GENERIC_MCP_TOOL_SEARCH_ID,
  GENERIC_MCP_TOOL_BLOCK_ID,
  LATER_TOOL_BLOCK_ID,
  SIDE_CHAT_PROMPT,
  SIDE_CHAT_COMPLETION_TEXT,
  SIDE_CHAT_FILENAME,
  SIDE_CHAT_QUEUE_FOLLOW_UP,
  SIDE_CHAT_GUIDANCE_INITIAL,
  SIDE_CHAT_GUIDANCE_FOLLOW_UP,
  SIDE_CHAT_GUIDANCE_COMPLETION,
  CLOUD_TASK_PROMPT,
  CLOUD_COMPLETION_TEXT,
  CLOUD_FOLLOW_UP_PROMPT,
  CLOUD_FOLLOW_UP_COMPLETION_TEXT,
  CLOUD_ARTIFACT_NAME,
  CLOUD_ARTIFACT_CONTENT,
  ACTIVE_WORKBENCH_SELECTOR,
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_SWITCH_MODEL_RETRY_SELECTOR,
  MACOS_LAUNCH_SERVICES_REGISTER,
  REQUEST_INPUT_ONLY,
  VIEW_IMAGE_ONLY,
  SHORT_CONVERSATION_ONLY,
  RETRY_ONLY,
  RATE_LIMIT_ONLY,
  RUNNING_FORK_ONLY,
  COMPLETED_FORK_ONLY,
  SIDE_CHAT_ONLY,
  GOAL_IDLE_ONLY,
  GOAL_BUSY_ONLY,
  GOAL_RESTART_ONLY,
  TURN_NAVIGATION_ONLY,
  ATTACHMENT_ONLY,
  PASTED_WORKSPACE_PATHS_ONLY,
  DROPPED_WORKSPACE_PATHS_ONLY,
  SYSTEM_DRAG_PANEL_ONLY,
  MODEL_SWITCH_ONLY,
  CLOUD_ONLY,
  CLOUD_FEATURES_ONLY,
  CLOUD_VISION_ONLY,
  PLUGINS_ONLY,
  AUTOMATION_ONLY,
  MEMORY_ONLY,
  WORKTREE_STATUS_ONLY,
  TOOL_BLOCK_ORDER_ONLY,
  QUEUE_NAVIGATION_ONLY,
  GUIDANCE_BACKGROUND_ONLY,
  GUIDANCE_SCROLL_ONLY,
  MESSAGE_RESTORATION_ONLY,
  MESSAGE_EDIT_ONLY,
  QUEUE_MANAGEMENT_ONLY,
  SEND_REJECTION_ONLY,
  TASK_PLAN_ONLY,
  DESKTOP_SCENARIO_ONLY,
  MIXED_TOOL_TURNS_ONLY,
  DESKTOP_SEGMENT,
  DESKTOP_FROM_SEGMENT,
  SELECTED_DESKTOP_SEGMENT,
  RUNS_PLUGIN_E2E,
  VERIFIES_INITIAL_TELEMETRY_CONSENT,
  scriptDir,
  weworkDir,
  repoDir,
  toolDetailsMcpServerPath,
  mcpElicitationServerPath,
  runId,
  resultDir,
  OFFICIAL_PLUGIN_REPOSITORY,
  OFFICIAL_PLUGIN_REPOSITORY_PREFIX,
  OFFICIAL_PLUGIN_REVISION,
  OFFICIAL_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DISPLAY_NAME,
  OFFICIAL_PLUGIN_MARKETPLACE_NAME,
  OFFICIAL_PLUGIN_SKILL_NAME,
  OFFICIAL_PLUGIN_SKILL_MARKER,
  OFFICIAL_PLUGIN_MCP_NAMESPACE,
  OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION,
  OFFICIAL_PLUGIN_MCP_SEARCH_ID,
  OFFICIAL_PLUGIN_SKILL_READY_TEXT,
  OFFICIAL_PLUGIN_COMPLETION_TEXT,
  PLUGIN_MARKETPLACE_NAME,
  PLUGIN_NAME,
  PLUGIN_CREATOR_PROMPT,
  PLUGIN_CREATOR_COMPLETION_TEXT,
  PLUGIN_REFINEMENT_PROMPT,
  PLUGIN_REFINEMENT_COMPLETION_TEXT,
  PLUGIN_DISPLAY_NAME,
  CONNECTOR_AUTH_MARKER_NAME,
  CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
  STARTUP_NETWORK_PROBE_MARKETPLACE_NAME,
  STARTUP_NETWORK_PROBE_MARKETPLACE_URL,
  AUTOMATION_NAME,
  AUTOMATION_PROMPT,
  AUTOMATION_COMPLETION_TEXT,
  AUTOMATION_SCHEDULE_TIMEOUT_MS,
  QUALIFIED_SKILL_MENTION_PROMPT,
  QUALIFIED_SKILL_MENTION_COMPLETION_TEXT,
  readCommandLineOption,
  getActiveOnlyModes,
  validateDesktopSegmentOptions,
  shouldRunDesktopCheckpoint,
  shouldStopAfterDesktopCheckpoint,
  shouldConfigureToolDetailsMcp,
  shouldRunPluginSegment,
  findFileBySuffix,
  createOfficialPluginMarketplaceFixture,
  createPluginMarketplaceFixture,
  withTimeout,
  isExecutable,
  pathExists,
  commandOutput,
  commandOutputAsync,
  stopDesktopAppProcess,
  runChecked,
  reservePort,
  BlockingNetworkProxy,
  waitForUrl,
  fetchJson,
  resolveExecutable,
  appendProcessOutput,
  processIsAlive,
  macosSleepAssertionIds,
  waitForMacosSleepAssertion,
  waitForExecutorRuntimeEvidence,
  waitForLogPattern,
  reactivateMacApplication,
  requestMacosApplicationQuit,
  triggerModelReloadUntilCloudFailure,
  sendPromptUntilScenarioRequest,
  visibleModelOptionId,
  revealGroupedModelOption,
  modelOptionIdCandidates,
  hasModelOption,
  ensureModelOptionVisible,
  confirmLocalProjectName,
  createSingleRootLocalProject,
  selectE2EModel,
  waitForE2EModelLabel,
}
