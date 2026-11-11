const MARKER = 'harness protocol input tool results tool_result_order='

export function readHarnessToolResultOrder(log, expectedIds) {
  for (const line of log.split('\n').reverse()) {
    const offset = line.indexOf(MARKER)
    if (offset < 0) continue
    const order = JSON.parse(JSON.parse(line.slice(offset + MARKER.length)))
    if (
      Array.isArray(order) &&
      order.length === expectedIds.length &&
      new Set(order).size === expectedIds.length &&
      order.every(id => expectedIds.includes(id))
    )
      return order
  }
  return null
}
