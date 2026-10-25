// Keep polling yielded native commands until Codex reports their terminal output.
export function accountCommandResult(input, callId) {
  const outputs = (Array.isArray(input) ? input : []).filter(
    item =>
      ['function_call_output', 'custom_tool_call_output'].includes(item?.type) &&
      (item.call_id === callId || item.call_id?.startsWith(`${callId}-poll-`))
  )
  if (!outputs.length) return null
  const text = item => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output))
  const last = text(outputs.at(-1))
  const running = last.match(/Process running with session ID (\d+)/)
  return running
    ? { sessionId: Number(running[1]), pollId: `${callId}-poll-${outputs.length}` }
    : { output: outputs.map(text).join('\n') }
}
import {
  customToolCall,
  functionCall,
  requestAdvertisesProgrammaticExec,
  selectProgrammaticExec,
  selectShellToolCommand,
  selectTool,
} from './response-protocol.mjs'

export function accountCommandEvents(request, callId, { command, workspacePath, sessionId }) {
  const poll = sessionId != null
  const args = poll
    ? { session_id: sessionId, chars: '', yield_time_ms: 1000 }
    : { cmd: command, workdir: workspacePath, yield_time_ms: 1000 }
  if (requestAdvertisesProgrammaticExec(request)) {
    const selection = selectProgrammaticExec(
      request,
      `text(await tools.${poll ? 'write_stdin' : 'exec_command'}(${JSON.stringify(args)}))`
    )
    const event = customToolCall(callId, selection.name, selection.input)
    event.item.namespace = 'functions'
    return [event]
  }
  const selection = poll
    ? selectTool(request, 'write_stdin', args)
    : selectShellToolCommand(request, command, workspacePath)
  return functionCall(callId, selection.name, selection.arguments)
}
