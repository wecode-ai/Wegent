import { APIRequestContext, expect, Page, TestInfo } from '@playwright/test'
import type { RetrievalConfigDraft } from '../../src/types/knowledge'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient, createBackendRequestHeaders } from './api-client'
import {
  configureDingTalkService,
  PROVIDER_NATIVE_API_URL,
  PROVIDER_NATIVE_MOCK_URL,
  resetMockMcp,
} from './provider-native-test-support'

/**
 * Shared support for the external document import E2E scenarios.
 *
 * Every scenario builds its own minimal data (knowledge base, synced DingTalk
 * nodes) against the real backend and tears it down afterwards. Only the
 * DingTalk and embedding providers are simulated; Wegent APIs are always real
 * requests, including remote indexing and chunk reads.
 */

export interface ExternalImportDocument {
  id: number
  name: string
  index_status: string
  is_active: boolean
  external_provider?: string | null
  external_resource_id?: string | null
  source_config?: Record<string, unknown> | null
}

export interface ExternalImportScenarioContext {
  token: string
  knowledgeBaseId: number
  knowledgeBaseName: string
  prefix: string
}

export interface MockImportConfig {
  documentContents?: Record<string, string>
  nodeFailures?: Record<string, string>
  hiddenNodeIds?: string[]
  pausedContentNodeIds?: string[]
}

function authHeaders(token: string): Record<string, string> {
  return createBackendRequestHeaders(token)
}

async function expectOk(response: {
  ok: () => boolean
  status: () => number
  text: () => Promise<string>
}) {
  expect(response.ok(), await response.text()).toBeTruthy()
}

/** Create an isolated KB, point DingTalk docs at the mock MCP, and sync the directory. */
export async function createExternalImportScenario(
  request: APIRequestContext,
  caseName: string,
  retrievalConfig: RetrievalConfigDraft
): Promise<ExternalImportScenarioContext> {
  const apiClient = createApiClient(request)
  const login = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data?.access_token || ''
  expect(token).toBeTruthy()

  const prefix = `e2e-dt-import-${caseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const kbName = `E2E-KB-${prefix}`
  const kbResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/knowledge-bases`, {
    headers: authHeaders(token),
    data: {
      name: kbName,
      description: 'External document import E2E scenario',
      namespace: 'default',
      kb_type: 'classic',
      rag_config_mode: 'auto',
      retrieval_config: retrievalConfig,
      summary_enabled: false,
    },
  })
  await expectOk(kbResponse)
  const knowledgeBase = await kbResponse.json()
  const knowledgeBaseId = (knowledgeBase as { id: number }).id
  expect(knowledgeBaseId).toBeTruthy()
  expect(knowledgeBase.retrieval_config).toMatchObject({ ...retrievalConfig })

  await resetMockMcp(request)
  await configureDingTalkService(request, token, 'docs', true)
  await configureDingTalkService(request, token, 'table', false)
  await configureDingTalkService(request, token, 'ai_table', false)
  await syncDingtalkDocs(request, token)

  return { token, knowledgeBaseId, knowledgeBaseName: kbName, prefix }
}

/** Tear a scenario down: delete remaining documents, the KB, and restore the mock. */
export async function cleanupExternalImportScenario(
  request: APIRequestContext,
  context: ExternalImportScenarioContext
): Promise<void> {
  const cleanupErrors: unknown[] = []
  let documents: ExternalImportDocument[] = []
  try {
    documents = await listDocuments(request, context.token, context.knowledgeBaseId)
  } catch (error) {
    cleanupErrors.push(error)
  }
  for (const document of documents) {
    try {
      const response = await request.delete(
        `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${document.id}`,
        {
          headers: authHeaders(context.token),
        }
      )
      await expectOk(response)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    const response = await request.delete(
      `${PROVIDER_NATIVE_API_URL}/api/knowledge-bases/${context.knowledgeBaseId}`,
      {
        headers: authHeaders(context.token),
      }
    )
    await expectOk(response)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await configureDingTalkService(request, context.token, 'docs', false)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await resetMockMcp(request)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    throw Object.assign(new Error('External import E2E cleanup failed'), {
      errors: cleanupErrors,
    })
  }
}

/** Refresh the synced DingTalk directory from the mock MCP. */
export async function syncDingtalkDocs(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`${PROVIDER_NATIVE_API_URL}/api/dingtalk-docs/sync`, {
    headers: authHeaders(token),
    timeout: 30_000,
  })
  await expectOk(response)
}

/** Apply import-scenario controls to the mock DingTalk MCP server. */
export async function configureMockImport(
  request: APIRequestContext,
  config: MockImportConfig
): Promise<{ waitingContentNodeIds: string[] }> {
  const response = await request.post(`${PROVIDER_NATIVE_MOCK_URL}/mcp-control/config`, {
    data: config,
  })
  await expectOk(response)
  return response.json()
}

/** Import external resources through the real batch import API. */
export async function importViaApi(
  request: APIRequestContext,
  token: string,
  knowledgeBaseId: number,
  externalResourceIds: string[],
  folderId = 0
): Promise<{
  created: Array<{ id: number; name: string }>
  updated: Array<{ id: number; name: string }>
  processing: Array<{ id: number; name: string }>
}> {
  const response = await request.post(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-bases/${knowledgeBaseId}/documents/external-import-batch`,
    {
      headers: authHeaders(token),
      data: {
        provider: 'dingtalk',
        external_resource_ids: externalResourceIds,
        folder_id: folderId,
      },
      timeout: 30_000,
    }
  )
  await expectOk(response)
  return await response.json()
}

export async function listDocuments(
  request: APIRequestContext,
  token: string,
  knowledgeBaseId: number,
  folderId?: number
): Promise<ExternalImportDocument[]> {
  const query = new URLSearchParams({ limit: '100', offset: '0' })
  if (folderId !== undefined) query.set('folder_id', String(folderId))
  const response = await request.get(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-bases/${knowledgeBaseId}/documents?${query.toString()}`,
    { headers: authHeaders(token) }
  )
  await expectOk(response)
  const body = (await response.json()) as { items: ExternalImportDocument[] }
  return body.items
}

/** Poll the real documents API until one document reaches a terminal status. */
export async function waitForDocument(
  request: APIRequestContext,
  token: string,
  knowledgeBaseId: number,
  documentName: string,
  options: { status?: string; timeout?: number } = {}
): Promise<ExternalImportDocument> {
  const expected = options.status ?? 'success'
  let latest: ExternalImportDocument | undefined
  await expect
    .poll(
      async () => {
        const documents = await listDocuments(request, token, knowledgeBaseId)
        latest = documents.find(document => document.name === documentName)
        return latest?.index_status ?? 'missing'
      },
      {
        timeout: options.timeout ?? 45_000,
        message: `Document ${documentName} should become ${expected}`,
      }
    )
    .toBe(expected)
  expect(latest).toBeDefined()
  return latest!
}

export async function getDocument(
  request: APIRequestContext,
  token: string,
  documentId: number
): Promise<ExternalImportDocument> {
  const response = await request.get(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${documentId}`,
    { headers: authHeaders(token) }
  )
  await expectOk(response)
  return await response.json()
}

export async function renameDocument(
  request: APIRequestContext,
  token: string,
  documentId: number,
  name: string
): Promise<void> {
  const response = await request.put(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${documentId}`,
    { headers: authHeaders(token), data: { name } }
  )
  await expectOk(response)
}

export async function moveDocument(
  request: APIRequestContext,
  token: string,
  documentId: number,
  folderId: number
): Promise<void> {
  const response = await request.put(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${documentId}/move`,
    { headers: authHeaders(token), data: { folder_id: folderId } }
  )
  await expectOk(response)
}

export async function deleteDocument(
  request: APIRequestContext,
  token: string,
  documentId: number
): Promise<void> {
  const response = await request.delete(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${documentId}`,
    { headers: authHeaders(token) }
  )
  await expectOk(response)
}

/** Read the indexed chunks of a document (retrieval data plane evidence). */
export async function getDocumentChunks(
  request: APIRequestContext,
  token: string,
  documentId: number
): Promise<string> {
  const response = await request.get(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${documentId}/chunks?page=1&page_size=50`,
    { headers: authHeaders(token) }
  )
  await expectOk(response)
  const body = (await response.json()) as { items: Array<{ content?: string }> }
  return JSON.stringify(body.items ?? [])
}

export async function createFolder(
  request: APIRequestContext,
  token: string,
  knowledgeBaseId: number,
  name: string
): Promise<number> {
  const response = await request.post(
    `${PROVIDER_NATIVE_API_URL}/api/knowledge-bases/${knowledgeBaseId}/folders`,
    { headers: authHeaders(token), data: { name, parent_id: 0 } }
  )
  await expectOk(response)
  return ((await response.json()) as { id: number }).id
}

/** Open the knowledge page of one KB through the real frontend. */
export async function openKnowledgeBase(page: Page, knowledgeBaseId: number): Promise<void> {
  await page.goto(`/knowledge?type=document&kb=${knowledgeBaseId}`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.getByTestId('upload-documents-button')).toBeVisible({ timeout: 30_000 })
}

/**
 * Drive the real "add materials" dialog: pick the DingTalk source, select the
 * given nodes, optionally choose a target folder, and submit the import.
 */
export async function importThroughDialog(
  page: Page,
  nodeIds: string[],
  options: { sourceFolderPath?: string[]; targetFolderName?: string } = {}
): Promise<void> {
  await page.getByTestId('upload-documents-button').click()
  await page.getByTestId('dingtalk-source-button').click()
  await expect(page.getByTestId('dingtalk-document-list')).toBeVisible({ timeout: 30_000 })

  for (const folderId of options.sourceFolderPath ?? []) {
    await page.getByTestId(`dingtalk-folder-navigate-${folderId}`).click()
  }

  for (const nodeId of nodeIds) {
    await page.getByTestId(`dingtalk-node-select-${nodeId}`).click()
  }

  if (options.targetFolderName) {
    await page.getByTestId('dingtalk-import-folder-select').click()
    await page.getByRole('option', { name: options.targetFolderName }).click()
  }

  await page.getByTestId('dingtalk-import-submit').click()
  await expect(page.getByTestId('dingtalk-import-result')).toBeVisible({ timeout: 30_000 })
}

/** Attach request and document-state evidence when a scenario fails. */
export async function attachExternalImportEvidence(
  testInfo: TestInfo,
  request: APIRequestContext,
  context: ExternalImportScenarioContext
): Promise<void> {
  if (
    testInfo.status !== 'failed' &&
    testInfo.status !== 'timedOut' &&
    testInfo.status !== 'interrupted'
  ) {
    return
  }
  const evidence: Record<string, unknown> = { knowledgeBaseId: context.knowledgeBaseId }
  try {
    evidence.mcpCalls = await request
      .get(`${PROVIDER_NATIVE_MOCK_URL}/mcp-control/calls`)
      .then(response => response.json())
      .catch(error => String(error))
  } catch (error) {
    evidence.mcpCalls = String(error)
  }
  try {
    evidence.documents = await listDocuments(request, context.token, context.knowledgeBaseId).catch(
      error => String(error)
    )
  } catch (error) {
    evidence.documents = String(error)
  }
  await testInfo.attach('external-import-evidence', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
}
