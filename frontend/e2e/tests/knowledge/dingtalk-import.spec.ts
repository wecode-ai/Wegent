import { APIRequestContext, expect, test } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { EXTERNAL_IMPORT_MARKERS, EXTERNAL_IMPORT_NODES } from '../../utils/mock-provider-mcp'
import {
  attachExternalImportEvidence,
  cleanupExternalImportScenario,
  configureMockImport,
  createExternalImportScenario,
  createFolder,
  deleteDocument,
  getDocumentChunks,
  importThroughDialog,
  importViaApi,
  listDocuments,
  openKnowledgeBase,
  waitForDocument,
  ExternalImportScenarioContext,
} from '../../utils/external-import-test-support'
import {
  authHeaders,
  getMcpCalls,
  PROVIDER_NATIVE_API_URL,
} from '../../utils/provider-native-test-support'

/**
 * External document import closed-loop E2E.
 *
 * Runs against the real frontend, backend, and test database. Only the
 * DingTalk provider is simulated (mock MCP server); every Wegent API call is
 * real. Each scenario builds and cleans its own minimal data and never
 * depends on another scenario. The default Chat provider-native DingTalk
 * selection stays covered by provider-native-dingtalk.spec.ts.
 */
test.describe.configure({ mode: 'serial' })

test.describe('External DingTalk document import', () => {
  // Active scenario context for failure-evidence collection (serial mode).
  let activeContext: ExternalImportScenarioContext | null = null

  test.afterEach(async ({ request }, testInfo) => {
    if (activeContext) {
      await attachExternalImportEvidence(testInfo, request, activeContext).catch(() => null)
    }
  })

  /**
   * Run one scenario: build fresh data, run the body, then tear the data down.
   * The body failure is reported first; a cleanup failure is logged but never
   * masks it, and still fails the test when the body passed.
   */
  async function runScenario(
    request: APIRequestContext,
    caseName: string,
    body: (context: ExternalImportScenarioContext) => Promise<void>
  ): Promise<void> {
    activeContext = null
    const context = await createExternalImportScenario(request, caseName)
    activeContext = context
    let bodyError: unknown = null
    try {
      await body(context)
    } catch (error) {
      bodyError = error
    } finally {
      let cleanupError: unknown = null
      try {
        await cleanupExternalImportScenario(request, context)
      } catch (error) {
        cleanupError = error
      }
      if (cleanupError && bodyError) {
        console.error('Scenario cleanup failed (body failure reported first):', cleanupError)
      }
      if (bodyError) throw bodyError
      if (cleanupError) throw cleanupError
    }
  }

  test('imports one DingTalk document through the add-materials dialog', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await runScenario(request, 'single', async context => {
      await openKnowledgeBase(page, context.knowledgeBaseId)

      await importThroughDialog(page, [EXTERNAL_IMPORT_NODES.product])
      await page.getByTestId('dingtalk-import-done').click()

      const document = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_产品说明'
      )
      expect(document.external_provider).toBe('dingtalk')
      expect(document.external_resource_id).toBe(EXTERNAL_IMPORT_NODES.product)

      const chunks = await getDocumentChunks(request, context.token, document.id)
      expect(chunks).toContain(EXTERNAL_IMPORT_MARKERS.productV1)

      // The imported document is visible in the real document list.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId(`document-row-${document.id}`)).toBeVisible({
        timeout: 30_000,
      })
    })
  })

  test('batch-imports a folder into a chosen target folder', async ({ page, request }) => {
    test.setTimeout(150_000)
    await runScenario(request, 'folder', async context => {
      const targetFolderId = await createFolder(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_目标文件夹'
      )
      await openKnowledgeBase(page, context.knowledgeBaseId)

      // The folder selection expands to its importable descendants (the
      // nested subfolder's document is included, the structure is not copied).
      await importThroughDialog(page, [EXTERNAL_IMPORT_NODES.folderRoot], {
        targetFolderName: 'E2E_目标文件夹',
      })
      await page.getByTestId('dingtalk-import-done').click()

      const expectedNames = ['E2E_产品说明', 'E2E_接口规范', 'E2E_归档说明']
      for (const name of expectedNames) {
        await waitForDocument(request, context.token, context.knowledgeBaseId, name)
      }

      const inTarget = await listDocuments(
        request,
        context.token,
        context.knowledgeBaseId,
        targetFolderId
      )
      expect(inTarget.map(document => document.name).sort()).toEqual([...expectedNames].sort())
      const inRoot = await listDocuments(request, context.token, context.knowledgeBaseId, 0)
      expect(inRoot).toHaveLength(0)
    })
  })

  test('duplicate import is skipped; delete then import creates a fresh copy', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await runScenario(request, 'duplicate', async context => {
      const imported = await importViaApi(request, context.token, context.knowledgeBaseId, [
        EXTERNAL_IMPORT_NODES.product,
      ])
      expect(imported.imported).toHaveLength(1)
      const documentId = imported.imported[0].id
      await waitForDocument(request, context.token, context.knowledgeBaseId, 'E2E_产品说明')

      await configureMockImport(request, {
        documentContents: {
          [EXTERNAL_IMPORT_NODES.product]: `# 产品说明\n\n唯一断言标记：\`${EXTERNAL_IMPORT_MARKERS.productV2}\``,
        },
      })

      await openKnowledgeBase(page, context.knowledgeBaseId)
      await importThroughDialog(page, [EXTERNAL_IMPORT_NODES.product])
      await expect(page.getByTestId('dingtalk-import-result')).toContainText('skipped 1')
      await page.getByTestId('dingtalk-import-done').click()

      const unchangedChunks = await getDocumentChunks(request, context.token, documentId)
      expect(unchangedChunks).toContain(EXTERNAL_IMPORT_MARKERS.productV1)
      expect(unchangedChunks).not.toContain(EXTERNAL_IMPORT_MARKERS.productV2)

      await deleteDocument(request, context.token, documentId)
      const fresh = await importViaApi(request, context.token, context.knowledgeBaseId, [
        EXTERNAL_IMPORT_NODES.product,
      ])
      expect(fresh.imported).toHaveLength(1)
      const freshDocument = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_产品说明'
      )
      expect(freshDocument.id).not.toBe(documentId)
      const freshChunks = await getDocumentChunks(request, context.token, freshDocument.id)
      expect(freshChunks).toContain(EXTERNAL_IMPORT_MARKERS.productV2)
    })
  })

  test('a batch partially fails and the failed document can retry in place', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await runScenario(request, 'retry', async context => {
      await configureMockImport(request, {
        nodeFailures: { [EXTERNAL_IMPORT_NODES.api]: 'fetch_failed' },
      })

      await openKnowledgeBase(page, context.knowledgeBaseId)
      await importThroughDialog(page, [EXTERNAL_IMPORT_NODES.product, EXTERNAL_IMPORT_NODES.api])
      await page.getByTestId('dingtalk-import-done').click()

      const okDocument = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_产品说明'
      )
      const failedDocument = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_接口规范',
        { status: 'failed' }
      )
      expect(okDocument.index_status).toBe('success')

      // The failure is visible in the document list.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId(`document-processing-error-${failedDocument.id}`)).toBeVisible({
        timeout: 30_000,
      })

      // Retry uses the dedicated import entry and reuses the same record even
      // while the provider failure persists.
      const callsBefore = await countContentFetches(request, EXTERNAL_IMPORT_NODES.api)
      await page.getByTestId(`retry-import-document-${failedDocument.id}`).click()
      await expect
        .poll(async () => countContentFetches(request, EXTERNAL_IMPORT_NODES.api), {
          timeout: 45_000,
          message: 'The retry should fetch the external body again',
        })
        .toBeGreaterThan(callsBefore)
      const stillFailed = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_接口规范',
        { status: 'failed' }
      )
      expect(stillFailed.id).toBe(failedDocument.id)

      // Remove the provider failure and retry to completion.
      await configureMockImport(request, {
        nodeFailures: {},
        documentContents: {
          [EXTERNAL_IMPORT_NODES.api]: `# 接口规范（更新）\n\n唯一断言标记：\`${EXTERNAL_IMPORT_MARKERS.apiV2}\``,
        },
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByTestId(`retry-import-document-${failedDocument.id}`).click()
      const recovered = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_接口规范',
        { status: 'success' }
      )
      expect(recovered.id).toBe(failedDocument.id)

      const documents = await listDocuments(request, context.token, context.knowledgeBaseId)
      expect(documents).toHaveLength(2)
      const chunks = await getDocumentChunks(request, context.token, recovered.id)
      expect(chunks).toContain(EXTERNAL_IMPORT_MARKERS.apiV2)
      expect(chunks).not.toContain(EXTERNAL_IMPORT_MARKERS.api)
    })
  })

  test('deleting an in-flight document is final and the late task stands down', async ({
    request,
  }) => {
    test.setTimeout(120_000)
    await runScenario(request, 'delete', async context => {
      // Slow the provider fetch so the import is still running when deleted.
      await configureMockImport(request, {
        responseDelays: { [EXTERNAL_IMPORT_NODES.product]: 5000 },
      })

      const imported = await importViaApi(request, context.token, context.knowledgeBaseId, [
        EXTERNAL_IMPORT_NODES.product,
      ])
      expect(imported.imported).toHaveLength(1)
      const documentId = imported.imported[0].id

      await deleteDocument(request, context.token, documentId)

      // The late task fetched the content but must not resurrect the document:
      // keep probing the deleted record while the delayed fetch settles.
      await expect
        .poll(async () => countContentFetches(request, EXTERNAL_IMPORT_NODES.product), {
          timeout: 30_000,
          message: 'The in-flight task should have fetched the external body',
        })
        .toBeGreaterThan(0)
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const documents = await listDocuments(request, context.token, context.knowledgeBaseId)
        expect(documents, 'the deleted document must stay deleted').toHaveLength(0)
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      const deleted = await request.get(
        `${PROVIDER_NATIVE_API_URL}/api/knowledge-documents/${documentId}`,
        { headers: authHeaders(context.token) }
      )
      expect(deleted.status()).toBe(404)
    })
  })

  test('a read-only member cannot import into the knowledge base', async ({ request }) => {
    test.setTimeout(120_000)
    await runScenario(request, 'permission', async context => {
      const regularUserToken = await loginRegularUser(request)
      const regularUserId = await request
        .get(`${PROVIDER_NATIVE_API_URL}/api/users/me`, {
          headers: authHeaders(regularUserToken),
        })
        .then(response => response.json())
        .then((body: { id?: number }) => body.id)
      expect(regularUserId).toBeTruthy()

      const memberResponse = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/share/knowledgebase/${context.knowledgeBaseId}/members`,
        {
          headers: authHeaders(context.token),
          data: { user_id: regularUserId, role: 'Reporter' },
        }
      )
      expect(memberResponse.ok(), await memberResponse.text()).toBeTruthy()

      const importResponse = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/knowledge-bases/${context.knowledgeBaseId}/documents/external-import-batch`,
        {
          headers: authHeaders(regularUserToken),
          data: {
            provider: 'dingtalk',
            external_resource_ids: [EXTERNAL_IMPORT_NODES.product],
            folder_id: 0,
          },
        }
      )
      expect(importResponse.status()).toBe(403)

      const documents = await listDocuments(request, context.token, context.knowledgeBaseId)
      expect(documents).toHaveLength(0)
    })
  })
})

async function countContentFetches(request: APIRequestContext, nodeId: string): Promise<number> {
  const calls = await getMcpCalls(request)
  return calls.filter(
    call => call.name === 'get_document_content' && call.arguments?.nodeId === nodeId
  ).length
}

async function loginRegularUser(request: APIRequestContext): Promise<string> {
  const apiClient = createApiClient(request)
  const login = await apiClient.login(REGULAR_USER.username, REGULAR_USER.password)
  const token = login.data?.access_token || ''
  expect(token).toBeTruthy()
  return token
}
