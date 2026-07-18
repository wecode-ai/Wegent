export function removeQueuedCommand(queue, id) {
  const index = queue.findIndex(item => item.id === id)
  if (index >= 0) queue.splice(index, 1)
}

export function requestedControlPort(session) {
  return session.controlUrl ? Number(new URL(session.controlUrl).port) : 0
}
