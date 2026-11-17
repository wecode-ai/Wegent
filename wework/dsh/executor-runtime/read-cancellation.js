export function isCancellableRuntimeRead(method) {
  return [
    'runtime.tasks.transcript',
    'runtime.connections.git.read',
    'runtime.connections.mcp',
    'runtime.connections.cli',
  ].includes(method)
}
