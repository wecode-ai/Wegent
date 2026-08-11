import { APIRequestContext, expect } from '@playwright/test'

export const PROVIDER_NATIVE_MARKERS = {
  a1: 'WEGENT-A1-NEW-2026',
  a2: 'WEGENT-A2-LEGACY-2024',
  a3: 'WEGENT-A3-RELEASE-1.4.0',
} as const

export interface ProviderNativeKnowledgeFixture {
  knowledgeBase: { id: number; name: string }
  folders: {
    requirements: { id: number; name: string }
    history: { id: number; name: string }
  }
  documents: {
    a1: { id: number; name: string }
    a2: { id: number; name: string }
    a3: { id: number; name: string }
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

  const knowledgeBase = await expectJson<{ id: number; name: string }>(
    await request.post(`${apiBaseUrl}/api/knowledge-bases`, {
      headers,
      data: {
        name: kbName,
        description: 'Provider-native knowledge access E2E fixture',
        namespace: 'default',
        kb_type: 'classic',
        rag_config_mode: 'disabled',
        summary_enabled: false,
      },
    })
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
    `# 新版方案\n\n唯一断言标记：\`${PROVIDER_NATIVE_MARKERS.a1}\``
  )
  const a2 = await createDocument(
    request,
    apiBaseUrl,
    token,
    knowledgeBase.id,
    history.id,
    'Doc-A2_旧版方案.md',
    `# 旧版方案\n\n唯一断言标记：\`${PROVIDER_NATIVE_MARKERS.a2}\``
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

  return {
    knowledgeBase,
    folders: { requirements, history },
    documents: { a1, a2, a3 },
  }
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
