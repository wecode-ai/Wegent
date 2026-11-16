import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  MATRIX_PROVIDER_INSTRUCTIONS,
  MATRIX_LEGACY_INSTRUCTIONS,
} from './model-native-catalog.mjs'
import { dirname, join, resolve } from 'node:path'
import {
  assertCodeModeOutput,
  assertCodeModeRequest,
  wireDeclarations,
} from './model-wire-contract.mjs'
import {
  customToolCall,
  functionCall,
  matrixCaseId,
  matrixPatch,
  matrixArtifact,
  matrixArtifactContent,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

export const MATRIX_UNUSED_SKILL_CANARY = 'MATRIX_UNUSED_SKILL_BODY_MUST_NEVER_BE_LOADED_29BD'
export const INITIAL_CONTEXT_TOKEN_LIMIT = 12_000
export const MATRIX_REQUIRED_TOOLS = ['get_goal', 'exec_command', 'apply_patch']
const MATRIX_DISCOVERY_SCRIPT =
  'text(ALL_TOOLS.filter(tool => tool.name.includes("get_issue_details") || ["get_goal","exec_command","apply_patch"].includes(tool.name)))'
export const MATRIX_SKILL_DESCRIPTION = 'Model protocol matrix verification skill.'
export const MATRIX_SKILL_CANARY = 'MATRIX_SKILL_BODY_MUST_ONLY_APPEAR_AFTER_READ_7C46'
export const MATRIX_MCP_DESCRIPTION = 'Get deterministic issue details for the Wework desktop E2E.'
export const matrixHiCompletion = model =>
  `MATRIX_HI_${model.execution}_${model.source}_${model.protocol}_${model.requestMode ?? 'auto'}`
export const matrixDeferredPrompt = model => `${matrixHiCompletion(model)}_DEFER`
export const matrixDeferredCompletion = model => `${matrixDeferredPrompt(model)}_COMPLETE`
export const matrixSkillPath = workspace =>
  join(workspace, '.agents', 'skills', 'model-matrix', 'SKILL.md')

let requestEncoding
const require = createRequire(import.meta.url)

export function countModelRequest(body) {
  const serialized = JSON.stringify(body)
  const clientBundle = process.env.WEWORK_E2E_SOCKET_IO_CLIENT
  requestEncoding ??= require(
    clientBundle ? resolve(dirname(clientBundle), 'tiktoken.cjs') : 'tiktoken'
  ).get_encoding('o200k_base')
  return {
    encoding: 'o200k_base',
    tokens: requestEncoding.encode(serialized, [], []).length,
    bytes: Buffer.byteLength(serialized),
  }
}

function strings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

export function assertProgressiveHi(body, model, budget = countModelRequest(body)) {
  const failures = []
  const lastUser = (body.input ?? body.messages ?? []).filter(item => item.role === 'user').at(-1)
  const prompt =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : ((lastUser?.content ?? []).filter(part => ['input_text', 'text'].includes(part.type)).at(-1)
          ?.text ?? '')
  assert.equal(
    prompt,
    'hi',
    'The budget must measure the real default hi, not a title or prediction request'
  )
  if (budget.tokens >= INITIAL_CONTEXT_TOKEN_LIMIT)
    failures.push(
      `complete request uses ${budget.tokens} ${budget.encoding} tokens (must be < ${INITIAL_CONTEXT_TOKEN_LIMIT})`
    )
  const text = strings(body).join('\n')
  if (model.source === 'codex') {
    if (text.split(MATRIX_PROVIDER_INSTRUCTIONS).length - 1 !== 1)
      failures.push('Provider canonical instructions must appear exactly once')
    if (text.includes(MATRIX_LEGACY_INSTRUCTIONS))
      failures.push('Legacy instructions replaced the provider canonical template')
  } else if (!text.includes('You are Codex,')) {
    failures.push('The native Codex catalog instructions are missing')
  }
  for (const marker of [
    MATRIX_SKILL_CANARY,
    MATRIX_UNUSED_SKILL_CANARY,
    MATRIX_MCP_DESCRIPTION,
    'wework-runtime:coding',
    'Read [workflow.md](workflow.md)',
    "You are Codex, Wework's coding assistant.",
    'Run JavaScript in the persistent Node REPL.',
    '### `get_goal`',
    '### `create_goal`',
    '### `update_goal`',
  ]) {
    if (text.includes(marker)) failures.push(`unloaded capability body leaked: ${marker}`)
  }
  const declarations = wireDeclarations(body, model.protocol)
  const bootstrap = new Set([
    'exec',
    'wait',
    'request_user_input',
    'request_user_input_async',
    'tool_search',
    'search_deferred_tools',
  ])
  for (const tool of declarations) {
    if (tool.type === 'web_search' && !tool.name && !tool.parameters && !tool.input_schema) continue
    const name = tool.name?.replace(/^functions__/, '') ?? tool.type
    const nativeNamespace = !tool.namespace || tool.namespace === 'functions'
    if (!nativeNamespace || !bootstrap.has(name)) {
      failures.push('undiscovered tool schema leaked: ' + (tool.namespace ?? '') + '.' + name)
    }
    for (const match of (tool.description ?? '').matchAll(/### \x60([^\x60]+)\x60/g)) {
      if (!bootstrap.has(match[1]))
        failures.push('expanded nested tool declaration leaked: ' + match[1])
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'))
  return budget
}

export function captureMatrixRequest(control, model, body) {
  assert.ok(
    control.matrixEvidenceDirectory,
    'The matrix must retain final model-side request evidence'
  )
  const caseId = `${matrixCaseId(model)}${model.requestMode ? '' : '-auto'}`
  const directory = control.matrixEvidenceDirectory
  mkdirSync(directory, { recursive: true })
  const sequence = control.matrixState.requests.length
  const prefix = join(directory, `model-matrix-${caseId}`)
  writeFileSync(`${prefix}-${sequence}.request.json`, JSON.stringify(body, null, 2))
  return prefix
}

function execSelection(body, protocol) {
  const candidates = wireDeclarations(body, protocol).filter(tool =>
    ['exec', 'functions__exec'].includes(tool.name)
  )
  assert.equal(
    candidates.length,
    1,
    'The progressive matrix requires the native exec discovery entrypoint'
  )
  return candidates[0]
}

function callOutput(body, protocol, callId) {
  if (protocol === 'responses') {
    const item = body.input?.find(
      item => item.call_id === callId && item.type?.endsWith('_call_output')
    )
    assert.ok(item, `Missing native result for ${callId}`)
    return strings(item.output).join('\n')
  }
  if (protocol === 'chat') {
    const message = body.messages?.find(
      message => message.role === 'tool' && message.tool_call_id === callId
    )
    assert.ok(message, `Missing Chat tool result for ${callId}`)
    return strings(message.content).join('\n')
  }
  const block = body.messages
    ?.flatMap(message => message.content ?? [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === callId)
  assert.ok(block, `Missing Anthropic tool result for ${callId}`)
  assert.notEqual(block.is_error, true)
  return strings(block.content).join('\n')
}

function writeExec(control, response, model, body, callId, script) {
  const tool = execSelection(body, model.protocol)
  if (model.protocol === 'responses') {
    const call =
      tool.type === 'custom'
        ? [customToolCall(callId, tool.name, script)]
        : functionCall(callId, tool.name, { input: script })
    if (tool.namespace)
      for (const event of call) if (event.item) event.item.namespace = tool.namespace
    control.writeSse(response, [responseCreated(callId), ...call, responseCompleted(callId)])
  } else if (model.protocol === 'chat') {
    control.writeChatToolCall(response, { input: script }, callId, tool.name)
  } else {
    control.writeAnthropicToolCall(response, { input: script }, callId, tool.name)
  }
}

// The model is scripted; discovery, the MCP process and file reads remain native.
export function handleProgressiveMatrixTurn(control, response, model, body) {
  const state = control.matrixState
  assert.ok(
    !strings(body).join('\n').includes(MATRIX_UNUSED_SKILL_CANARY),
    'Loading one skill expanded an unrelated skill body'
  )
  if (state.progressive === 'complete') return false
  if (!state.progressive && !JSON.stringify(body).includes(matrixDeferredPrompt(model)))
    return false
  if (!state.progressive) {
    assert.ok(
      !strings(body).join('\n').includes(MATRIX_MCP_DESCRIPTION),
      'The MCP schema appeared before discovery'
    )
    state.deferAudit = {
      strategy: 'native-code-mode',
      mcpDiscovery: 'pending',
      mcpCall: 'pending',
      builtinCall: 'pending',
      skillRead: 'pending',
    }
    state.progressive = 'discovery'
    writeExec(control, response, model, body, 'matrix-discover', MATRIX_DISCOVERY_SCRIPT)
    return true
  }
  if (state.progressive === 'discovery') {
    const output = callOutput(body, model.protocol, 'matrix-discover')
    assert.ok(
      output.includes(MATRIX_MCP_DESCRIPTION),
      'Native discovery did not return the MCP definition'
    )
    const inventory = assertRequiredToolInventory(output)
    const mcp = inventory.filter(tool => tool.name.endsWith('get_issue_details'))
    state.deferAudit.mcpDiscovery = 'passed'
    state.progressiveInventory = inventory.map(tool => tool.name)
    state.progressiveDefinitions = inventory
    const name = mcp[0].name
    assert.match(name, /^(mcp__)?github__issues__/, 'Discovery lost the MCP server binding')
    assert.match(
      name,
      /^[A-Za-z_$][A-Za-z0-9_$]*$/,
      'Discovery returned an unsafe JavaScript tool identifier'
    )
    assert.ok(output.includes('get_goal'), 'The built-in goal reader was not discoverable')
    state.progressiveToolName = name
    state.progressive = 'goal'
    writeExec(control, response, model, body, 'matrix-goal', 'text(await tools.get_goal({}))')
    return true
  }
  if (state.progressive === 'goal') {
    const output = callOutput(body, model.protocol, 'matrix-goal')
    assert.match(
      output,
      /[\"]?goal[\"]?\s*:\s*null/,
      'A plain hi must not implicitly create a Goal'
    )
    state.deferAudit.builtinCall = 'passed'
    const name = state.progressiveToolName
    state.progressive = 'mcp'
    writeExec(
      control,
      response,
      model,
      body,
      'matrix-mcp',
      `text(await tools.${name}({owner:"wework-e2e",repo:"matrix",issue_number:42}))`
    )
    return true
  }
  if (state.progressive === 'mcp') {
    const output = callOutput(body, model.protocol, 'matrix-mcp')
    assert.ok(output.includes('Tool detail verification'), `The real MCP call failed: ${output}`)
    assert.match(output, /issue_number[\\"\s:]+42/)
    assert.ok(
      !strings(body).join('\n').includes(MATRIX_SKILL_CANARY),
      'Skill content appeared before its file was read'
    )
    assert.ok(
      strings(body).join('\n').includes(MATRIX_SKILL_DESCRIPTION),
      'The relevant skill metadata was lost before its body could be loaded'
    )
    state.deferAudit.mcpCall = 'passed'
    state.deferAudit.skillMetadata = 'passed'
    const path = matrixSkillPath(
      model.execution === 'cloud' ? control.cloudWorkspacePath : control.workspacePath
    )
    const quoted = `'${path.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
    const command =
      process.platform === 'win32' ? `Get-Content -Raw -LiteralPath ${quoted}` : `cat ${quoted}`
    state.progressive = 'skill'
    writeExec(
      control,
      response,
      model,
      body,
      'matrix-skill',
      `text(await tools.exec_command({cmd:${JSON.stringify(command)},login:false}))`
    )
    return true
  }
  if (state.progressive === 'skill') {
    const output = callOutput(body, model.protocol, 'matrix-skill')
    assert.ok(output.includes(MATRIX_SKILL_CANARY), `Native skill read failed: ${output}`)
    state.deferAudit.skillRead = 'passed'
    state.progressive = 'rediscovery'
    writeExec(control, response, model, body, 'matrix-rediscover', MATRIX_DISCOVERY_SCRIPT)
    return true
  }
  if (state.progressive === 'rediscovery') {
    const inventory = assertRequiredToolInventory(
      callOutput(body, model.protocol, 'matrix-rediscover')
    )
    assert.deepEqual(
      inventory,
      state.progressiveDefinitions,
      'Required capabilities changed or disappeared after executing tools and loading a skill'
    )
    state.deferAudit.rediscovery = 'passed'
    state.deferAudit.status = 'complete'
    state.progressive = 'complete'
    control.writeMatrixAssistantMessage(response, model, matrixDeferredCompletion(model))
    return true
  }
  assert.fail(`Unexpected progressive matrix request after ${state.progressive}`)
}

export function hasMatrixExec(body, protocol) {
  return wireDeclarations(body, protocol).some(tool =>
    ['exec', 'functions__exec'].includes(tool.name)
  )
}

function patchCall(model) {
  const artifact = matrixArtifact(model)
  const cmd =
    process.platform === 'win32'
      ? "Get-Content -Raw -LiteralPath '" + artifact + "'"
      : "cat '" + artifact + "'"
  return {
    callId: 'matrix-' + matrixCaseId(model) + '-tool',
    script:
      'await tools.apply_patch(' +
      JSON.stringify(matrixPatch(model)) +
      '); text(await tools.exec_command(' +
      JSON.stringify({ cmd, login: false }) +
      '))',
    marker: matrixArtifactContent(model),
  }
}

export function writeCodeModeMatrixPatch(control, response, model, body) {
  const { callId, script } = patchCall(model)
  writeExec(control, response, model, body, callId, script)
}

export function assertCodeModeMatrixPatch(body, model) {
  assertCodeModeOutput(body, model.protocol, patchCall(model))
}

export function assertCodeModeMatrixRequest(body, model) {
  // Matrix Codex providers have custom endpoints and use the portable defaults.
  const exec = assertCodeModeRequest(body, { protocol: model.protocol, lite: false })
  if (model.protocol === 'responses' && model.source === 'codex') {
    assert.equal(exec.type, 'function', 'Configured Codex providers must default to function tools')
    assert.equal(exec.name, 'functions__exec')
    assert.equal(exec.namespace, undefined)
  }
}

export function assertRequiredToolInventory(output) {
  const start = output.indexOf('[')
  assert.ok(start >= 0, 'Discovery did not return a structured native tool inventory')
  const inventory = JSON.parse(output.slice(start))
  for (const required of MATRIX_REQUIRED_TOOLS) {
    const matches = inventory.filter(tool => tool.name === required)
    assert.equal(matches.length, 1, 'A required built-in tool was lost or duplicated: ' + required)
    assert.ok(
      matches[0].description?.includes(required),
      'Discovery lost the signature of ' + required
    )
  }
  const mcp = inventory.filter(tool => tool.name.endsWith('get_issue_details'))
  assert.equal(mcp.length, 1, 'The required MCP tool was lost or duplicated')
  assert.equal(
    inventory.length,
    MATRIX_REQUIRED_TOOLS.length + 1,
    'Discovery expanded unrelated capabilities'
  )
  return inventory
}
