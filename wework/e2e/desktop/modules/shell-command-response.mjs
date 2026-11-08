import { selectedToolCall } from './model-tool-calls.mjs'
import {
  codexRequestMetadata,
  customToolCall,
  functionCall,
  requestAdvertisesProgrammaticExec,
  selectProgrammaticExec,
  selectShellToolCommand,
  selectTool,
} from './response-protocol.mjs'

export function requestAdvertisesShellCommand(request) {
  return (
    requestAdvertisesProgrammaticExec(request) ||
    request.tools?.some(tool => ['exec_command', 'shell_command'].includes(tool.name)) === true
  )
}

function programmaticCommand(request, callId, method, args) {
  const program = [
    `const result = await tools.${method}(${JSON.stringify(args)})`,
    'text(result.session_id ? `Process running with session ID ${result.session_id}` : `Process exited with code ${result.exit_code}`)',
    'text(result.output)',
  ].join('\n')
  const exec = selectProgrammaticExec(request, program)
  return selectedToolCall(callId, { codeMode: exec })
}

export function shellCommandResponse(request, callId, command, workspacePath, options = {}) {
  if (requestAdvertisesProgrammaticExec(request)) {
    return programmaticCommand(request, callId, 'exec_command', {
      cmd: command,
      workdir: workspacePath,
      yield_time_ms: 1000,
      ...options,
    })
  }
  const tool = selectShellToolCommand(request, command, workspacePath)
  Object.assign(tool.arguments, options)
  return selectedToolCall(callId, tool)
}

export function shellCommandRequestDiagnostic(body) {
  const metadata = codexRequestMetadata(body)
  return {
    model: body.model ?? null,
    requestKind: metadata?.request_kind ?? null,
    threadSource: metadata?.thread_source ?? null,
    toolChoice: body.tool_choice ?? null,
    tools: body.tools ?? null,
    input: Array.isArray(body.input)
      ? body.input.map(item => ({
          type: item?.type ?? null,
          role: item?.role ?? null,
          ...(item?.type === 'additional_tools' ? { tools: item.tools } : {}),
        }))
      : { type: typeof body.input },
  }
}

export function shellCommandPollResponse(request, callId, sessionId) {
  const args = { session_id: sessionId, chars: '', yield_time_ms: 1000 }
  if (requestAdvertisesProgrammaticExec(request)) {
    return programmaticCommand(request, callId, 'write_stdin', args)
  }
  const tool = selectTool(request, 'write_stdin', args)
  return selectedToolCall(callId, tool)
}
