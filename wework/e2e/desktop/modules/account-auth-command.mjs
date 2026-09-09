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
