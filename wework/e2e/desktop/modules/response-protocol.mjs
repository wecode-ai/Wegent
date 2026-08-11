import {
  ARTIFACT_CONTENT,
  ARTIFACT_NAME,
  CLOUD_ARTIFACT_CONTENT,
  CLOUD_ARTIFACT_NAME,
  IMAGE_ARTIFACT_NAME,
  LOCAL_MODEL_CASES,
  LOCAL_MODEL_SWITCH_ARTIFACT,
  LOCAL_MODEL_SWITCH_ARTIFACT_CONTENT,
  MEMORY_COMPLETION_TEXT,
  MODEL_PROTOCOL_MATRIX_TEXT_PREFIX,
  MODEL_PROTOCOL_MATRIX_TOOL_PREFIX,
  OFFICIAL_PLUGIN_DISPLAY_NAME,
  OFFICIAL_PLUGIN_MCP_NAMESPACE,
  OFFICIAL_PLUGIN_MCP_TOOL_DESCRIPTION,
  assert,
  join,
} from './shared.mjs'

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
  return {
    type: 'response.output_item.done',
    item: {
      type: 'tool_search_call',
      call_id: callId,
      execution: 'client',
      arguments: argumentsValue,
    },
  }
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
    const isToolOutput = type === 'function_call_output' || type === 'custom_tool_call_output'
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
  const namespaces = requestToolSearchResults(request).filter(
    candidate => candidate?.type === 'namespace' && candidate.name === OFFICIAL_PLUGIN_MCP_NAMESPACE
  )
  assert.equal(
    namespaces.length,
    1,
    'tool_search did not return exactly one official plugin MCP namespace'
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
    'The searched official plugin MCP namespace did not expose exactly one destination confirmation tool'
  )
  const tool = matchingTools[0]
  assert.ok(
    tool.description.includes(`plugin \`${OFFICIAL_PLUGIN_DISPLAY_NAME}\``),
    'The searched MCP tool did not retain official plugin provenance'
  )
  assert.deepEqual(
    new Set(tool.parameters?.required),
    new Set(['workspacePath', 'targetPath']),
    'The searched MCP tool did not require both workspace confinement inputs'
  )
  return { namespace: namespace.name, name: tool.name, arguments: argumentsValue }
}

function selectMcpTool(request, namespaceName, toolName, argumentsValue) {
  const namespace = requestToolSearchResults(request).find(
    candidate => candidate?.type === 'namespace' && candidate.name === namespaceName
  )
  assert.ok(namespace, `tool_search did not return MCP namespace ${namespaceName}`)
  const tool = namespace.tools?.find(
    candidate => candidate?.type === 'function' && candidate.name === toolName
  )
  assert.ok(tool, `Searched MCP namespace ${namespaceName} did not expose ${toolName}`)
  return { namespace: namespace.name, name: tool.name, arguments: argumentsValue }
}

function selectConvertedTool(request, toolName, argumentsValue) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const names = tools.map(tool => tool?.name ?? tool?.function?.name).filter(Boolean)
  const name = names.find(
    candidate => candidate === toolName || candidate.endsWith(`__${toolName}`)
  )
  assert.ok(name, `Converted request did not expose ${toolName}: ${names.join(', ')}`)
  return { name, arguments: argumentsValue }
}

function selectToolSearch(request, query) {
  const tools = Array.isArray(request.tools) ? request.tools : []
  const toolNames = tools.map(tool => tool?.name ?? tool?.function?.name).filter(Boolean)
  const searchTools = tools.filter(
    tool =>
      tool?.type === 'tool_search' ||
      (tool?.type === 'function' &&
        (tool?.name === 'tool_search' || tool?.function?.name === 'tool_search'))
  )
  assert.equal(searchTools.length, 1, 'Real Codex did not advertise exactly one tool_search tool')
  assert.equal(
    tools.some(tool => tool?.type === 'namespace'),
    false,
    'Real Codex eagerly advertised namespace tools before tool_search'
  )
  assert.equal(
    toolNames.some(name => /(^|__)browser_/.test(name)),
    false,
    `Real Codex eagerly advertised Wework browser tools before tool_search: ${toolNames.join(', ')}`
  )
  const encodedTools = Buffer.byteLength(JSON.stringify(tools))
  assert.ok(
    encodedTools < 32 * 1024,
    `Real Codex first-turn tool payload exceeded 32 KiB: ${encodedTools} bytes`
  )
  return { query, limit: 8 }
}

function requestToolSearchResults(request) {
  const outputs = []
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value === 'string') {
      try {
        visit(JSON.parse(value))
      } catch {
        // Non-JSON strings cannot contain tool search results.
      }
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.tools)) {
      outputs.push(...value.tools)
    }
    Object.values(value).forEach(visit)
  }
  visit(request.input ?? [])
  return outputs
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

export {
  createSse,
  codexRequestKind,
  latestModelInputText,
  responseCreated,
  responseCompleted,
  responseFailed,
  functionCall,
  namespacedFunctionCall,
  toolSearchCall,
  customToolCall,
  assistantMessageSequence,
  assistantMessage,
  encryptedReasoningItem,
  streamingMarkdownReport,
  streamingTextEvents,
  localProtocolCase,
  localProtocolPrompt,
  localProtocolArtifact,
  localProtocolArtifactContent,
  localProtocolPatch,
  localModelSwitchCommand,
  matrixCaseId,
  matrixTextPrompt,
  matrixTextCompletion,
  matrixToolPrompt,
  matrixToolCompletion,
  matrixToolPreamble,
  matrixArtifact,
  matrixArtifactContent,
  matrixPatch,
  readRequestBody,
  readRawRequestBody,
  parseTelemetryPayload,
  telemetryEvents,
  json,
  cors,
  requestContainsToolOutput,
  requestAdvertisesShellTool,
  requestAdvertisesViewImageTool,
  selectTool,
  selectOfficialPluginMcpTool,
  selectMcpTool,
  selectConvertedTool,
  selectToolSearch,
  requestToolSearchResults,
  selectShellTool,
  selectShellToolCommand,
  selectApplyPatchTool,
  selectCloudApplyPatchTool,
  selectViewImageTool,
  snapshotHasAssistantActivity,
}
