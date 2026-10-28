export function currentTurnHasToolOutput(body, callId) {
  const input = Array.isArray(body.input) ? body.input : []
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (item?.role === 'user') return false
    if (item?.type === 'function_call_output' && item.call_id === callId) return true
  }
  return false
}

export function currentTurnHasToolSearchResult(body, namespaceName) {
  const input = Array.isArray(body.input) ? body.input : []
  let turnStart = 0
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === 'user') {
      turnStart = index + 1
      break
    }
  }
  return input.slice(turnStart).some(item => JSON.stringify(item).includes(namespaceName))
}
