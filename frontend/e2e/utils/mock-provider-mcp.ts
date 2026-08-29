import * as http from 'http'

interface McpToolCall {
  timestamp: string
  name: string
  arguments: Record<string, unknown>
  result: unknown
  isError: boolean
}

const toolCalls: McpToolCall[] = []
const contentGates = new Map<
  string,
  { waiting: boolean; promise: Promise<void>; release: () => void }
>()

function setPausedContentNodes(nodeIds: string[]): void {
  for (const [nodeId, gate] of contentGates) {
    if (!nodeIds.includes(nodeId)) {
      contentGates.delete(nodeId)
      gate.release()
    }
  }
  for (const nodeId of nodeIds) {
    if (contentGates.has(nodeId)) continue
    let release!: () => void
    const promise = new Promise<void>(resolve => (release = resolve))
    contentGates.set(nodeId, { waiting: false, promise, release })
  }
}

const state = {
  deniedNodeIds: new Set<string>(),
  documentNames: { 'doc-d1': 'Doc-D1_新设计' } as Record<string, string>,
  // Import-scenario controls: content overrides, injected get_document_content
  // failures, and nodes hidden from list_nodes.
  documentContents: {} as Record<string, string>,
  nodeFailures: {} as Record<string, string>,
  hiddenNodeIds: new Set<string>(),
}

export const EXTERNAL_IMPORT_NODES = {
  folderRoot: 'imp-root',
  formatsRoot: 'imp-formats',
  subFolder: 'imp-sub',
  product: 'imp-product',
  api: 'imp-api',
  archive: 'imp-archive',
  sheet: 'imp-sheet',
  table: 'imp-table',
  pdf: 'imp-pdf',
} as const

export const EXTERNAL_IMPORT_MARKERS = {
  productV1: 'DINGTALK-PRODUCT-V1',
  productV2: 'DINGTALK-PRODUCT-V2',
  api: 'DINGTALK-API-V1',
  apiV2: 'DINGTALK-API-V2',
  archive: 'DINGTALK-ARCHIVE-V1',
} as const

const documents: Record<string, { name: string; content: string }> = {
  'doc-d1': {
    name: 'Doc-D1_新设计',
    content: '# 新设计\n\n唯一断言标记：`DING-D1-NATIVE-2026`',
  },
  'doc-d2': {
    name: 'Doc-D2_旧设计',
    content: '# 旧设计\n\n唯一断言标记：`DING-D2-FEDERATED-2024`',
  },
  'doc-d3': {
    name: 'Doc-D3_项目说明',
    content: '# 项目说明\n\n项目代号 ORION。唯一断言标记：`DING-D3-PROJECT-ORION`',
  },
  'doc-m1': {
    name: 'Doc-M1_个人记录',
    content:
      '# 个人记录\n\n唯一断言标记：`DING-M1-PERSONAL-ALPHA`\n\n私有提示：`PERSONAL-CODE-7429`',
  },
  [EXTERNAL_IMPORT_NODES.product]: {
    name: 'E2E_产品说明',
    content: `# 产品说明\n\n唯一断言标记：\`${EXTERNAL_IMPORT_MARKERS.productV1}\``,
  },
  [EXTERNAL_IMPORT_NODES.api]: {
    name: 'E2E_接口规范',
    content: `# 接口规范\n\n唯一断言标记：\`${EXTERNAL_IMPORT_MARKERS.api}\``,
  },
  [EXTERNAL_IMPORT_NODES.archive]: {
    name: 'E2E_归档说明',
    content: `# 归档说明\n\n唯一断言标记：\`${EXTERNAL_IMPORT_MARKERS.archive}\``,
  },
}

const tools = [
  ['list_wikiSpaces', 'List DingTalk knowledge spaces'],
  ['list_nodes', 'List nodes in a DingTalk space or folder'],
  ['search_documents', 'Search DingTalk documents'],
  ['get_document_info', 'Get DingTalk document metadata'],
  ['get_document_content', 'Read DingTalk online document content'],
  ['rename_document', 'Rename a DingTalk document'],
  ['update_document_content', 'Update DingTalk document content'],
  ['create_document', 'Create a DingTalk document'],
  ['delete_document', 'Delete a DingTalk document'],
  ['get_ai_table_records', 'Read DingTalk AI table records'],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: true },
}))

export function handleProviderMcpHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  port: number
): boolean {
  const url = new URL(req.url || '/', `http://localhost:${port}`)
  if (url.pathname === '/mcp' && req.method === 'POST') {
    handleMcpRequest(req, res, body, port)
    return true
  }
  if (url.pathname === '/mcp' && req.method === 'DELETE') {
    res.writeHead(200)
    res.end()
    return true
  }
  if (url.pathname === '/mcp-control/calls' && req.method === 'GET') {
    writeJson(res, 200, toolCalls)
    return true
  }
  if (url.pathname === '/mcp-control/reset' && req.method === 'POST') {
    setPausedContentNodes([])
    toolCalls.length = 0
    state.deniedNodeIds.clear()
    state.documentNames = { 'doc-d1': 'Doc-D1_新设计' }
    state.documentContents = {}
    state.nodeFailures = {}
    state.hiddenNodeIds.clear()
    writeJson(res, 200, { status: 'reset' })
    return true
  }
  if (url.pathname === '/mcp-control/config' && req.method === 'POST') {
    const config = parseJsonBody<{
      deniedNodeIds?: string[]
      documentNames?: Record<string, string>
      documentContents?: Record<string, string>
      nodeFailures?: Record<string, string>
      hiddenNodeIds?: string[]
      pausedContentNodeIds?: string[]
    }>(body)
    // Each field present in the request replaces the whole field, so passing
    // an empty object clears that control. documentNames merges instead: it
    // layers display-name overrides on top of the defaults.
    if (config?.deniedNodeIds) {
      state.deniedNodeIds = new Set(config.deniedNodeIds)
    }
    if (config?.documentNames) {
      state.documentNames = { ...state.documentNames, ...config.documentNames }
    }
    if (config?.documentContents) {
      state.documentContents = config.documentContents
    }
    if (config?.nodeFailures) {
      state.nodeFailures = config.nodeFailures
    }
    if (config?.hiddenNodeIds) {
      state.hiddenNodeIds = new Set(config.hiddenNodeIds)
    }
    if (config?.pausedContentNodeIds) {
      setPausedContentNodes(config.pausedContentNodeIds)
    }
    writeJson(res, 200, {
      deniedNodeIds: [...state.deniedNodeIds],
      documentNames: state.documentNames,
      documentContents: state.documentContents,
      nodeFailures: state.nodeFailures,
      hiddenNodeIds: [...state.hiddenNodeIds],
      pausedContentNodeIds: [...contentGates.keys()],
      waitingContentNodeIds: [...contentGates]
        .filter(([, gate]) => gate.waiting)
        .map(([nodeId]) => nodeId),
    })
    return true
  }
  return false
}

export function providerMcpToolCallCount(): number {
  return toolCalls.length
}

function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  port: number
): void {
  void handleMcpRequestAsync(req, res, body, port)
}

async function handleMcpRequestAsync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  port: number
): Promise<void> {
  const message = parseJsonBody<{
    id?: string | number
    method?: string
    params?: Record<string, unknown>
  }>(body)
  if (!message?.method) {
    writeJson(res, 400, { error: 'Invalid MCP request' })
    return
  }
  if (message.method === 'notifications/initialized') {
    res.writeHead(202, { 'Mcp-Session-Id': 'mock-mcp-session' })
    res.end()
    return
  }

  let result: unknown
  let completedToolCall: McpToolCall | null = null
  if (message.method === 'initialize') {
    result = {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'wegent-e2e-provider-mcp', version: '1.0.0' },
    }
  } else if (message.method === 'tools/list') {
    result = { tools: toolsForRequest(req, port) }
  } else if (message.method === 'tools/call') {
    const params = message.params || {}
    const name = String(params.name || '')
    const args =
      params.arguments && typeof params.arguments === 'object'
        ? (params.arguments as Record<string, unknown>)
        : {}
    const nodeId = String(args.nodeId || args.node_id || '')
    const gate = name === 'get_document_content' ? contentGates.get(nodeId) : undefined
    if (gate) {
      gate.waiting = true
      await gate.promise
    }
    const outcome = await callTool(name, args)
    completedToolCall = {
      timestamp: new Date().toISOString(),
      name,
      arguments: args,
      result: outcome.result,
      isError: outcome.isError,
    }
    result = {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      isError: outcome.isError,
    }
  } else {
    writeJson(res, 404, { error: `Unsupported MCP method ${message.method}` })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Mcp-Session-Id': 'mock-mcp-session',
  })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), () => {
    // Expose a tool call only after its MCP response has been fully flushed.
    // Deletion E2E scenarios use this as the provider-fetch completion signal
    // before observing the backend's guarded attachment-write stability window.
    if (completedToolCall) toolCalls.push(completedToolCall)
  })
}

function toolsForRequest(req: http.IncomingMessage, port: number): typeof tools {
  const service = new URL(req.url || '/mcp', `http://localhost:${port}`).searchParams.get('service')
  if (service === 'wikispace') return tools.filter(tool => tool.name === 'list_wikiSpaces')
  if (service === 'ai_table') {
    return tools.filter(tool => tool.name === 'get_ai_table_records')
  }
  return tools.filter(
    tool => tool.name !== 'list_wikiSpaces' && tool.name !== 'get_ai_table_records'
  )
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ result: unknown; isError: boolean }> {
  const nodeId = String(args.nodeId || args.node_id || '')
  if (nodeId && state.deniedNodeIds.has(nodeId)) {
    return {
      result: { code: 'permission_denied', message: `No permission to read ${nodeId}` },
      isError: true,
    }
  }
  if (name === 'list_wikiSpaces') {
    return {
      result: {
        items: [
          {
            workspaceId: 'space-d',
            name: 'Space-D_项目空间',
            url: 'https://alidocs.dingtalk.com/i/spaces/space-d/overview',
          },
        ],
      },
      isError: false,
    }
  }
  if (name === 'list_nodes') return { result: listNodes(args), isError: false }
  if (name === 'search_documents') return searchDocuments(args)
  if (name === 'get_document_info') return documentInfo(nodeId)
  if (name === 'get_document_content') return documentContent(nodeId)
  if (name === 'rename_document') return renameDocument(nodeId, args)
  if (name === 'get_ai_table_records') {
    return {
      result: {
        tableId: String(args.tableId || ''),
        records: [{ rowId: 'row-1', value: 'AI-TABLE-ROW-BETA-2026' }],
      },
      isError: false,
    }
  }
  return {
    result: { code: 'unsupported_tool', message: `Unsupported tool ${name}` },
    isError: true,
  }
}

function visibleNodes(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items.filter(item => !state.hiddenNodeIds.has(String(item.nodeId || '')))
}

function listNodes(args: Record<string, unknown>): Record<string, unknown> {
  const folderId = String(args.folderId || '')
  const workspaceId = String(args.workspaceId || '')
  const pageToken = String(args.pageToken || '')
  if (!folderId && !workspaceId) {
    return {
      items: visibleNodes([
        node('doc-m1', 'Doc-M1_个人记录', 'doc', '', ''),
        node(EXTERNAL_IMPORT_NODES.folderRoot, 'E2E_项目资料', 'folder', '', ''),
        node(EXTERNAL_IMPORT_NODES.formatsRoot, 'E2E_格式展示', 'folder', '', ''),
      ]),
    }
  }
  if (workspaceId === 'space-d' && !folderId && !pageToken) {
    return {
      items: [node('folder-d', 'Folder-D_设计', 'folder', 'space-d', 'space-d')],
      nextPageToken: 'space-d-page-2',
      hasMore: true,
    }
  }
  if (workspaceId === 'space-d' && !folderId && pageToken === 'space-d-page-2') {
    return {
      items: [node('doc-d3', 'Doc-D3_项目说明', 'doc', 'space-d', 'space-d')],
      hasMore: false,
    }
  }
  if (folderId === 'folder-d') {
    return {
      items: [
        node('folder-d1', 'Folder-D1_归档', 'folder', 'folder-d', 'space-d'),
        node('doc-d1', 'Doc-D1_新设计', 'doc', 'folder-d', 'space-d'),
      ],
    }
  }
  if (folderId === 'folder-d1') {
    return { items: [node('doc-d2', 'Doc-D2_旧设计', 'doc', 'folder-d1', 'space-d')] }
  }
  if (folderId === EXTERNAL_IMPORT_NODES.formatsRoot) {
    return {
      items: visibleNodes(
        [
          [EXTERNAL_IMPORT_NODES.sheet, 'E2E_在线表格', 'axls', 'ALIDOC'],
          [EXTERNAL_IMPORT_NODES.table, 'E2E_AI表格', 'able', 'ALIDOC'],
          [EXTERNAL_IMPORT_NODES.pdf, 'E2E_文件.pdf', 'pdf', 'FILE'],
        ].map(([nodeId, name, extension, contentType]) => ({
          nodeId,
          name,
          nodeType: 'file',
          contentType,
          extension,
          parentId: EXTERNAL_IMPORT_NODES.formatsRoot,
        }))
      ),
    }
  }
  if (folderId === EXTERNAL_IMPORT_NODES.folderRoot) {
    return {
      items: visibleNodes([
        node(
          EXTERNAL_IMPORT_NODES.subFolder,
          'E2E_归档',
          'folder',
          EXTERNAL_IMPORT_NODES.folderRoot,
          ''
        ),
        node(
          EXTERNAL_IMPORT_NODES.product,
          'E2E_产品说明',
          'doc',
          EXTERNAL_IMPORT_NODES.folderRoot,
          ''
        ),
        node(
          EXTERNAL_IMPORT_NODES.api,
          'E2E_接口规范',
          'doc',
          EXTERNAL_IMPORT_NODES.folderRoot,
          ''
        ),
      ]),
    }
  }
  if (folderId === EXTERNAL_IMPORT_NODES.subFolder) {
    return {
      items: visibleNodes([
        node(
          EXTERNAL_IMPORT_NODES.archive,
          'E2E_归档说明',
          'doc',
          EXTERNAL_IMPORT_NODES.subFolder,
          ''
        ),
      ]),
    }
  }
  return { items: [] }
}

function searchDocuments(args: Record<string, unknown>) {
  const keywords = String(args.keywords || args.keyword || args.query || '')
  const workspaceIds = args.workspaceIds
  if (
    !keywords.toUpperCase().includes('ORION') ||
    !Array.isArray(workspaceIds) ||
    !workspaceIds.includes('space-d')
  ) {
    return { result: { items: [], hasMore: false }, isError: false }
  }
  return args.pageToken
    ? {
        result: {
          items: [node('doc-d3', 'Doc-D3_项目说明', 'doc', 'space-d', 'space-d')],
          hasMore: false,
        },
        isError: false,
      }
    : {
        result: { items: [], nextPageToken: 'orion-page-2', hasMore: true },
        isError: false,
      }
}

function documentInfo(nodeId: string) {
  const document = documents[nodeId]
  return document
    ? {
        result: {
          success: true,
          nodeId,
          name: state.documentNames[nodeId] || document.name,
          nodeType: 'file',
          contentType: 'ALIDOC',
          extension: 'adoc',
          url: `https://alidocs.dingtalk.com/i/nodes/${nodeId}`,
        },
        isError: false,
      }
    : { result: { code: 'not_found', message: `Unknown document ${nodeId}` }, isError: true }
}

function documentContent(nodeId: string) {
  const failureCode = state.nodeFailures[nodeId]
  if (failureCode) {
    return {
      result: { code: failureCode, message: `Injected failure for ${nodeId}` },
      isError: true,
    }
  }
  const document = documents[nodeId]
  if (!document) {
    return { result: { code: 'not_found', message: `Unknown document ${nodeId}` }, isError: true }
  }
  const content = state.documentContents[nodeId] ?? document.content
  return { result: { success: true, nodeId, markdown: content }, isError: false }
}

function renameDocument(nodeId: string, args: Record<string, unknown>) {
  const newName = String(args.name || args.title || '')
  if (!documents[nodeId] || !newName) {
    return {
      result: { code: 'invalid_request', message: 'nodeId and name are required' },
      isError: true,
    }
  }
  state.documentNames[nodeId] = newName
  return { result: { nodeId, name: newName, updated: true }, isError: false }
}

function node(
  nodeId: string,
  name: string,
  nodeType: 'folder' | 'doc',
  parentId: string,
  workspaceId: string
): Record<string, unknown> {
  return {
    nodeId,
    name: state.documentNames[nodeId] || name,
    nodeType: nodeType === 'doc' ? 'file' : 'folder',
    parentId,
    workspaceId,
    contentType: nodeType === 'doc' ? 'ALIDOC' : '',
    extension: nodeType === 'doc' ? 'adoc' : null,
    url: `https://alidocs.dingtalk.com/i/nodes/${nodeId}`,
    updateTime: '2026-08-11T00:00:00Z',
  }
}

function parseJsonBody<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

function writeJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data, null, 2))
}
