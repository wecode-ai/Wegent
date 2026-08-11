import { APIRequestContext, expect } from '@playwright/test'

export const PROVIDER_NATIVE_MARKERS = {
  a1: 'WEGENT-A1-NEW-2026',
  a2: 'WEGENT-A2-LEGACY-2024',
  a3: 'WEGENT-A3-RELEASE-1.4.0',
  b1: 'WEGENT-B1-OPS-P1',
} as const

export interface ProviderNativeKnowledgeFixture {
  knowledgeBase: { id: number; name: string }
  otherKnowledgeBase: { id: number; name: string }
  folders: {
    requirements: { id: number; name: string }
    history: { id: number; name: string }
  }
  documents: {
    a1: { id: number; name: string }
    a2: { id: number; name: string }
    a3: { id: number; name: string }
    b1: { id: number; name: string }
  }
}

interface CreateFixtureOptions {
  apiBaseUrl: string
  token: string
  nameSuffix: string
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function expectJson<T>(response: Awaited<ReturnType<APIRequestContext['post']>>) {
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as T
}

export async function createProviderNativeKnowledgeFixture(
  request: APIRequestContext,
  options: CreateFixtureOptions
): Promise<ProviderNativeKnowledgeFixture> {
  const { apiBaseUrl, token, nameSuffix } = options
  const headers = authHeaders(token)
  const kbName = `E2E-KB-A-${nameSuffix}`

  const knowledgeBase = await createKnowledgeBase(request, apiBaseUrl, headers, kbName)
  const otherKnowledgeBase = await createKnowledgeBase(
    request,
    apiBaseUrl,
    headers,
    `E2E-KB-B-${nameSuffix}`
  )

  const requirements = await createFolder(
    request,
    apiBaseUrl,
    token,
    knowledgeBase.id,
    'Folder-A_需求',
    0
  )
  const history = await createFolder(
    request,
    apiBaseUrl,
    token,
    knowledgeBase.id,
    'Folder-A1_历史版本',
    requirements.id
  )

  const a1 = await createDocument(
    request,
    apiBaseUrl,
    token,
    knowledgeBase.id,
    requirements.id,
    'Doc-A1_新版方案.md',
    [
      '# 新版方案',
      '',
      `唯一断言标记：\`${PROVIDER_NATIVE_MARKERS.a1}\``,
      '',
      '结论：采用 Provider 原生能力，减少后端聚合逻辑。',
      '',
      '核心设计第 5 点：Chat Shell 与 ClaudeCode 使用相同的 selected_knowledge_sources 提示词结构。',
    ].join('\n')
  )
  const a2 = await createDocument(
    request,
    apiBaseUrl,
    token,
    knowledgeBase.id,
    history.id,
    'Doc-A2_旧版方案.md',
    `# 旧版方案\n\n唯一断言标记：\`${PROVIDER_NATIVE_MARKERS.a2}\`\n\n结论：由统一知识控制面聚合检索结果。`
  )
  const a3 = await createDocument(
    request,
    apiBaseUrl,
    token,
    knowledgeBase.id,
    0,
    'Doc-A3_发布说明.md',
    `# 发布说明\n\n唯一断言标记：\`${PROVIDER_NATIVE_MARKERS.a3}\``
  )
  const b1 = await createDocument(
    request,
    apiBaseUrl,
    token,
    otherKnowledgeBase.id,
    0,
    'Doc-B1_故障手册.md',
    `# 故障手册\n\n唯一断言标记：\`${PROVIDER_NATIVE_MARKERS.b1}\``
  )

  return {
    knowledgeBase,
    otherKnowledgeBase,
    folders: { requirements, history },
    documents: { a1, a2, a3, b1 },
  }
}

async function createKnowledgeBase(
  request: APIRequestContext,
  apiBaseUrl: string,
  headers: Record<string, string>,
  name: string
) {
  return expectJson<{ id: number; name: string }>(
    await request.post(`${apiBaseUrl}/api/knowledge-bases`, {
      headers,
      data: {
        name,
        description: 'Provider-native knowledge access E2E fixture',
        namespace: 'default',
        kb_type: 'classic',
        rag_config_mode: 'disabled',
        summary_enabled: false,
      },
    })
  )
}

export async function deleteProviderNativeKnowledgeFixture(
  request: APIRequestContext,
  apiBaseUrl: string,
  token: string,
  knowledgeBaseId: number
): Promise<void> {
  const response = await request.delete(`${apiBaseUrl}/api/knowledge-bases/${knowledgeBaseId}`, {
    headers: authHeaders(token),
  })
  expect(response.ok(), await response.text()).toBeTruthy()
}

async function createFolder(
  request: APIRequestContext,
  apiBaseUrl: string,
  token: string,
  knowledgeBaseId: number,
  name: string,
  parentId: number
) {
  return expectJson<{ id: number; name: string }>(
    await request.post(`${apiBaseUrl}/api/knowledge-bases/${knowledgeBaseId}/folders`, {
      headers: authHeaders(token),
      data: { name, parent_id: parentId },
    })
  )
}

async function createDocument(
  request: APIRequestContext,
  apiBaseUrl: string,
  token: string,
  knowledgeBaseId: number,
  folderId: number,
  name: string,
  content: string
) {
  return expectJson<{ id: number; name: string }>(
    await request.post(`${apiBaseUrl}/api/knowledge/documents`, {
      headers: authHeaders(token),
      data: {
        knowledge_base_id: knowledgeBaseId,
        name,
        source_type: 'text',
        content,
        file_extension: 'md',
        folder_id: folderId,
      },
    })
  )
}
