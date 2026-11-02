import {
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
  const event = customToolCall(callId, exec.name, exec.input)
  event.item.namespace = 'functions'
  return [event]
}

export function shellCommandResponse(request, callId, command, workspacePath) {
  if (requestAdvertisesProgrammaticExec(request)) {
    return programmaticCommand(request, callId, 'exec_command', {
      cmd: command,
      workdir: workspacePath,
      yield_time_ms: 1000,
    })
  }
  const tool = selectShellToolCommand(request, command, workspacePath)
  return functionCall(callId, tool.name, tool.arguments)
}

export function shellCommandPollResponse(request, callId, sessionId) {
  const args = { session_id: sessionId, chars: '', yield_time_ms: 1000 }
  if (requestAdvertisesProgrammaticExec(request)) {
    return programmaticCommand(request, callId, 'write_stdin', args)
  }
  const tool = selectTool(request, 'write_stdin', args)
  return functionCall(callId, tool.name, tool.arguments)
}
