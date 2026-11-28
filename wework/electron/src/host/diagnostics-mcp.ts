const tools = [
  {
    name: 'inspect_conversation',
    description:
      'Read live in-memory state for a conversation on this device, including its queue, active turn, observed approvals and native Codex activity.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_instance',
    description:
      'Identify the running Wework instance and process IDs bound to this local diagnostic session.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_trace_logs',
    annotations: { readOnlyHint: true },
    description:
      'List diagnostic log sources or read a bounded redacted tail from the current instance. Sources include renderer startup, Electron host and executor transport traces.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'sample_process_stacks',
    description:
      'Collect a five-second native CPU and thread stack sample for a Wework component. Supported on macOS.',
    inputSchema: {
      type: 'object',
      properties: { target: { enum: ['main', 'renderer', 'executor'] } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_native_memory',
    description:
      'Export a macOS virtual memory region summary for the selected Wework process, including the native Executor.',
    inputSchema: {
      type: 'object',
      properties: { target: { enum: ['main', 'renderer', 'executor'] } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_main_cpu',
    description:
      'Record a ten-second Electron main-process V8 CPU profile and export it on this device.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'export_main_heap',
    description:
      'Export a local Electron main-process JavaScript heap snapshot. This may pause the current app. The snapshot can contain private application data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'record_renderer',
    description:
      'Record the current Wework workbench renderer while the user reproduces a problem. Returns local CPU profile, Chromium trace, and bounded console and exception stack files.',
    inputSchema: {
      type: 'object',
      properties: { durationMs: { type: 'integer', minimum: 1_000, maximum: 30_000 } },
      additionalProperties: false,
    },
  },
  {
    name: 'export_renderer_heap',
    description:
      'Export a local JavaScript heap snapshot of the current Wework workbench renderer. May briefly pause rendering. The snapshot can contain private application data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const

export async function dispatchDiagnosticsMcp(
  message: Record<string, unknown>,
  collect: (request: Record<string, unknown>) => Promise<unknown>
): Promise<Record<string, unknown> | null> {
  const { method, id } = message
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }
  }
  if (id === undefined) return null

  const respond = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const params = message.params as Record<string, unknown> | undefined
  if (method === 'initialize') {
    return respond({
      protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(
        String(params?.protocolVersion)
      )
        ? params?.protocolVersion
        : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'wework_diagnostics', version: '1.0.0' },
    })
  }
  if (method === 'ping') return respond({})
  if (method === 'tools/list') return respond({ tools })
  if (method !== 'tools/call') {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown MCP method' } }
  }

  try {
    const args = readArguments(params?.arguments)
    const name = params?.name
    let data: unknown
    if (
      name === 'inspect_conversation' &&
      Object.keys(args).length === 1 &&
      typeof args.taskId === 'string'
    ) {
      data = await collect({ action: 'inspect-conversation', taskId: args.taskId })
    } else if (name === 'get_instance' && Object.keys(args).length === 0) {
      data = await collect({ action: 'status' })
    } else if (name === 'record_renderer' && Object.keys(args).every(key => key === 'durationMs')) {
      data = await collect({ action: 'record', target: 'renderer', durationMs: args.durationMs })
    } else if (name === 'export_renderer_heap' && Object.keys(args).length === 0) {
      data = await collect({ action: 'heap', target: 'renderer' })
    } else if (name === 'read_trace_logs' && Object.keys(args).every(key => key === 'source')) {
      data = await collect({ action: 'logs', source: args.source })
    } else if (
      (name === 'sample_process_stacks' || name === 'inspect_native_memory') &&
      Object.keys(args).length === 1 &&
      ['main', 'renderer', 'executor'].includes(String(args.target))
    ) {
      data = await collect({
        action: name === 'sample_process_stacks' ? 'sample' : 'native-memory',
        target: args.target,
      })
    } else if (name === 'record_main_cpu' && Object.keys(args).length === 0) {
      data = await collect({ action: 'record', target: 'main' })
    } else if (name === 'export_main_heap' && Object.keys(args).length === 0) {
      data = await collect({ action: 'heap', target: 'main' })
    } else {
      throw new Error('Unknown diagnostics tool or unsupported arguments')
    }
    return respond({ content: [{ type: 'text', text: JSON.stringify(data) }] })
  } catch (error) {
    return respond({
      content: [
        { type: 'text', text: error instanceof Error ? error.message : 'Collection failed' },
      ],
      isError: true,
    })
  }
}

function readArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object')
  }
  return value as Record<string, unknown>
}
