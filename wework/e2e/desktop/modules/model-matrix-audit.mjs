import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { wireDeclarations } from './model-wire-contract.mjs'
import {
  functionCall,
  namespacedFunctionCall,
  responseCompleted,
  responseCreated,
  selectToolSearch,
  toolSearchResponseEvents,
} from './response-protocol.mjs'
import {
  MATRIX_MCP_DESCRIPTION,
  MATRIX_SKILL_CANARY,
  MATRIX_SKILL_DESCRIPTION,
  matrixDeferredCompletion,
  matrixSkillPath,
} from './model-progressive-contract.mjs'

export function recordMatrixFailure(control, phase, error) {
  const state = control.matrixState
  state.failures ??= []
  state.failures.push({ phase, message: error.message, stack: error.stack })
}

export function writeMatrixReport(control, model) {
  const state = control.matrixState
  const caseId = [model.execution, model.source, model.protocol, model.requestMode ?? 'auto'].join(
    '-'
  )
  const report = {
    caseId,
    execution: model.execution,
    source: model.source,
    protocol: model.protocol,
    requestMode: model.requestMode ?? 'auto',
    modelId: model.modelId,
    hi: state.hi ?? null,
    defer: state.deferAudit ?? { status: state.progressive ?? 'not-reached' },
    baseline: state.stage,
    failures: state.failures ?? [],
    passed: !state.failures?.length,
    requests: state.requests.length,
  }
  control.matrixReports ??= []
  const previous = control.matrixReports.findIndex(row => row.caseId === caseId)
  if (previous < 0) control.matrixReports.push(report)
  else control.matrixReports[previous] = report
  writeFileSync(
    join(control.matrixEvidenceDirectory, `model-matrix-${caseId}.result.json`),
    JSON.stringify(report, null, 2)
  )
  writeFileSync(
    join(control.matrixEvidenceDirectory, 'model-matrix-results.json'),
    JSON.stringify(control.matrixReports, null, 2)
  )
  return report
}

export function assertMatrixReports(control) {
  assert.ok(control.matrixReports?.length, 'No model matrix cases executed')
  const failed = (control.matrixReports ?? []).filter(report => !report.passed)
  if (failed.length)
    throw new AggregateError(
      failed.map(
        report =>
          new Error(
            `${report.caseId}: ${report.failures.map(failure => failure.phase + ': ' + failure.message).join('; ')}`
          )
      ),
      `${failed.length}/${control.matrixReports.length} model matrix cases failed; all case reports retained`
    )
}

function output(body, protocol, id) {
  if (protocol === 'responses') {
    const item = body.input?.find(item => item.call_id === id && item.type.endsWith('_output'))
    assert.ok(item, `Missing Responses result: ${id}`)
    return item.type === 'tool_search_output'
      ? JSON.stringify(item.tools)
      : JSON.stringify(item.output)
  }
  if (protocol === 'chat') {
    const item = body.messages?.find(item => item.role === 'tool' && item.tool_call_id === id)
    assert.ok(item, `Missing Chat result: ${id}`)
    return JSON.stringify(item.content)
  }
  const item = body.messages
    ?.flatMap(message => message.content ?? [])
    .find(item => item.type === 'tool_result' && item.tool_use_id === id)
  assert.ok(item, `Missing Anthropic result: ${id}`)
  assert.notEqual(item.is_error, true)
  return JSON.stringify(item.content)
}

function sendFunction(control, response, model, id, tool, args) {
  if (model.protocol === 'responses') {
    const events = tool.namespace
      ? namespacedFunctionCall(id, tool.namespace, tool.name, args)
      : functionCall(id, tool.name, args)
    control.writeSse(response, [responseCreated(id), ...events, responseCompleted(id)])
  } else if (model.protocol === 'chat') control.writeChatToolCall(response, args, id, tool.name)
  else control.writeAnthropicToolCall(response, args, id, tool.name)
}

function findTool(body, protocol, name) {
  const matches = wireDeclarations(body, protocol).filter(
    tool => tool.name === name || tool.name?.endsWith('__' + name)
  )
  assert.equal(matches.length, 1, `The model did not receive exactly one ${name} declaration`)
  return matches[0]
}

// Exercise the existing native search bridge even when the initial-loading gate fails.
// This records observed behavior; it does not turn an eager initial request into a pass.
export function handleDirectMatrixAudit(control, response, model, body) {
  const state = control.matrixState
  const audit = (state.deferAudit ??= {
    strategy: 'native-tool-search',
    mcpDiscovery: 'pending',
    mcpCall: 'pending',
    builtinCall: 'pending',
    skillRead: 'pending',
  })
  if (!state.directAuditStage) {
    const searchRequest =
      model.protocol === 'anthropic'
        ? {
            ...body,
            tools: body.tools?.map(tool => ({
              ...tool,
              type: 'function',
              parameters: tool.input_schema,
            })),
          }
        : body
    const search = selectToolSearch(searchRequest, 'github__issues get_issue_details')
    state.directAuditStage = 'search'
    if (model.protocol === 'responses')
      control.writeSse(response, [
        responseCreated('matrix-native-search'),
        ...toolSearchResponseEvents('matrix-native-search', search),
        responseCompleted('matrix-native-search'),
      ])
    else sendFunction(control, response, model, 'matrix-native-search', search, search.arguments)
    return true
  }
  if (state.directAuditStage === 'search') {
    assert.ok(
      output(body, model.protocol, 'matrix-native-search').includes(MATRIX_MCP_DESCRIPTION),
      'Native search lost the MCP schema'
    )
    audit.mcpDiscovery = 'passed'
    let tools = wireDeclarations(body, model.protocol)
    if (model.protocol === 'responses') {
      const batch = body.input.find(
        item => item.type === 'tool_search_output' && item.call_id === 'matrix-native-search'
      )
      if (batch)
        tools = batch.tools.flatMap(tool =>
          tool.type === 'namespace'
            ? tool.tools.map(member => ({ ...member, namespace: tool.name }))
            : [tool]
        )
    }
    const matches = tools.filter(
      tool => tool.name === 'get_issue_details' || tool.name?.endsWith('__get_issue_details')
    )
    assert.equal(matches.length, 1, 'Searched MCP tool was not available for invocation')
    state.directAuditStage = 'mcp'
    sendFunction(control, response, model, 'matrix-native-mcp', matches[0], {
      owner: 'wework-e2e',
      repo: 'matrix',
      issue_number: 42,
    })
    return true
  }
  if (state.directAuditStage === 'mcp') {
    const result = output(body, model.protocol, 'matrix-native-mcp')
    assert.ok(result.includes('Tool detail verification'), 'The real native MCP call failed')
    assert.ok(result.includes('42'))
    audit.mcpCall = 'passed'
    state.directAuditStage = 'goal'
    sendFunction(
      control,
      response,
      model,
      'matrix-native-goal',
      findTool(body, model.protocol, 'get_goal'),
      {}
    )
    return true
  }
  if (state.directAuditStage === 'goal') {
    const result = output(body, model.protocol, 'matrix-native-goal')
    assert.match(result, /goal[\\"\s:]+null/, 'Plain hi unexpectedly created a Goal')
    audit.builtinCall = 'passed-already-exposed'
    audit.skillMetadata = JSON.stringify(body).includes(MATRIX_SKILL_DESCRIPTION)
      ? 'passed'
      : 'missing'
    assert.equal(audit.skillMetadata, 'passed', 'Skill metadata was lost before loading')
    const path = matrixSkillPath(
      model.execution === 'cloud' ? control.cloudWorkspacePath : control.workspacePath
    )
    const quoted = "'" + path.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'"
    const cmd =
      process.platform === 'win32' ? `Get-Content -Raw -LiteralPath ${quoted}` : `cat ${quoted}`
    state.directAuditStage = 'skill'
    sendFunction(
      control,
      response,
      model,
      'matrix-native-skill',
      findTool(body, model.protocol, 'exec_command'),
      { cmd, login: false }
    )
    return true
  }
  if (state.directAuditStage === 'skill') {
    assert.ok(
      output(body, model.protocol, 'matrix-native-skill').includes(MATRIX_SKILL_CANARY),
      'The real skill read failed'
    )
    audit.skillRead = 'passed'
    audit.status = 'complete'
    state.progressive = 'complete'
    control.writeMatrixAssistantMessage(response, model, matrixDeferredCompletion(model))
    return true
  }
  assert.fail(`Unknown direct audit stage: ${state.directAuditStage}`)
}

export function matrixSkillNames(body) {
  const texts = []
  const visit = value => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(body)
  return [...texts.join('\n').matchAll(/^- (.+?): .+ \(file: [^\n]+\)$/gm)]
    .map(match => match[1])
    .sort()
}
