import { APIRequestContext, expect, test } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { createExternalImportRetrieval } from '../../utils/external-import-retrieval'
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
 * DingTalk and embedding providers are simulated; every Wegent API call is
 * real. Each scenario builds and cleans its own minimal data and never
 * depends on another scenario. The default Chat provider-native DingTalk
 * selection stays covered by provider-native-dingtalk.spec.ts.
 */
// Run sequentially because the provider is shared, but do not skip independent
// scenarios when an earlier one fails.
test.describe.configure({ mode: 'default' })

test.describe('External DingTalk document import', () => {
  // Active scenario context for failure-evidence collection.
  let activeContext: ExternalImportScenarioContext | null = null
  let retrieval: Awaited<ReturnType<typeof createExternalImportRetrieval>>

  test.beforeAll(async ({ request }) => {
    retrieval = await createExternalImportRetrieval(request)
  })

  test.afterAll(async ({ request }) => {
    if (retrieval) await retrieval.cleanup(request)
  })

  test.afterEach(async ({ request }, testInfo) => {
    if (!activeContext) return
    const context = activeContext
    activeContext = null
    try {
      await attachExternalImportEvidence(testInfo, request, context)
    } catch (error) {
      console.error('Failed to attach external import evidence:', error)
    } finally {
      try {
        await cleanupExternalImportScenario(request, context)
      } catch (error) {
        if (testInfo.status === 'passed') throw error
        console.error('Scenario cleanup failed (body failure reported first):', error)
      }
    }
  })

  /** Build fresh data and run the body; afterEach collects evidence before cleanup. */
  async function runScenario(
    request: APIRequestContext,
    caseName: string,
    body: (context: ExternalImportScenarioContext) => Promise<void>
  ): Promise<void> {
    activeContext = null
    const context = await createExternalImportScenario(request, caseName, retrieval.config)
    activeContext = context
    await body(context)
  }

  test('distinguishes supported formats from missing provider configuration', async ({
    page,
    request,
  }) => {
    await runScenario(request, 'formats', async context => {
      await openKnowledgeBase(page, context.knowledgeBaseId)
      await page.getByTestId('upload-documents-button').click()
      await page.getByTestId('dingtalk-source-button').click()
      await page
        .getByTestId(`dingtalk-folder-navigate-${EXTERNAL_IMPORT_NODES.formatsRoot}`)
        .click()

      await expect(
        page.getByTestId(`dingtalk-node-configure-${EXTERNAL_IMPORT_NODES.sheet}`)
      ).toBeVisible()
      await expect(
        page.getByTestId(`dingtalk-node-select-${EXTERNAL_IMPORT_NODES.sheet}`)
      ).toHaveCount(0)
      await expect(
        page.getByTestId(`dingtalk-node-configure-${EXTERNAL_IMPORT_NODES.table}`)
      ).toBeVisible()
      await expect(
        page.getByTestId(`dingtalk-node-select-${EXTERNAL_IMPORT_NODES.table}`)
      ).toHaveCount(0)
      const pdf = page.getByTestId(`dingtalk-node-select-${EXTERNAL_IMPORT_NODES.pdf}`)
      await expect(pdf).toBeEnabled()
      await pdf.click()
      await expect(pdf).toHaveAttribute('aria-checked', 'true')
      await pdf.click()
      await expect(pdf).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('dingtalk-import-submit')).toBeDisabled()
      await page.getByTestId('dingtalk-import-cancel').click()
      expect(await listDocuments(request, context.token, context.knowledgeBaseId)).toEqual([])
    })
  })

  test('imports one DingTalk document through the add-materials dialog', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await runScenario(request, 'single', async context => {
      await openKnowledgeBase(page, context.knowledgeBaseId)

      await page.getByTestId('upload-documents-button').click()
      await page.getByTestId('dingtalk-source-button').click()
      await page.getByTestId(`dingtalk-folder-navigate-${EXTERNAL_IMPORT_NODES.folderRoot}`).click()
      await page.getByTestId(`dingtalk-node-select-${EXTERNAL_IMPORT_NODES.product}`).click()
      await page.getByTestId('dingtalk-import-submit').click()
      await expect(page.getByTestId('dingtalk-import-result')).toBeVisible({ timeout: 30_000 })
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
      const indexedContent = (JSON.parse(chunks) as Array<{ content?: string }>)
        .map(chunk => chunk.content ?? '')
        .join('\n')
      expect(indexedContent).toContain(EXTERNAL_IMPORT_MARKERS.productV1)
      expect(indexedContent).not.toContain('"markdown"')
      expect(indexedContent).not.toContain('"success"')

      const calls = (await getMcpCalls(request)).filter(
        call => call.arguments.nodeId === EXTERNAL_IMPORT_NODES.product
      )
      expect(calls.map(call => call.name)).toEqual(['get_document_info', 'get_document_content'])
      expect(calls[1].arguments.format).toBe('markdown')

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

  test('reimport updates the same document with the latest external content', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await runScenario(request, 'duplicate', async context => {
      const imported = await importViaApi(request, context.token, context.knowledgeBaseId, [
        EXTERNAL_IMPORT_NODES.product,
      ])
      expect(imported.created).toHaveLength(1)
      const documentId = imported.created[0].id
      await waitForDocument(request, context.token, context.knowledgeBaseId, 'E2E_产品说明')

      await configureMockImport(request, {
        documentContents: {
          [EXTERNAL_IMPORT_NODES.product]: `# 产品说明\n\n唯一断言标记：\`${EXTERNAL_IMPORT_MARKERS.productV2}\``,
        },
      })

      await openKnowledgeBase(page, context.knowledgeBaseId)
      await importThroughDialog(page, [EXTERNAL_IMPORT_NODES.product], {
        sourceFolderPath: [EXTERNAL_IMPORT_NODES.folderRoot],
      })
      await expect(page.getByTestId('dingtalk-import-result')).toContainText('updated 1')
      await page.getByTestId('dingtalk-import-done').click()

      const updatedDocument = await waitForDocument(
        request,
        context.token,
        context.knowledgeBaseId,
        'E2E_产品说明',
        { status: 'success' }
      )
      expect(updatedDocument.id).toBe(documentId)
      const updatedChunks = await getDocumentChunks(request, context.token, documentId)
      expect(updatedChunks).toContain(EXTERNAL_IMPORT_MARKERS.productV2)
      expect(updatedChunks).not.toContain(EXTERNAL_IMPORT_MARKERS.productV1)
      const documents = await listDocuments(request, context.token, context.knowledgeBaseId)
      expect(documents).toHaveLength(1)
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
      await importThroughDialog(page, [EXTERNAL_IMPORT_NODES.product, EXTERNAL_IMPORT_NODES.api], {
        sourceFolderPath: [EXTERNAL_IMPORT_NODES.folderRoot],
      })
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
      const callsBefore = await countCompletedContentFetches(request, EXTERNAL_IMPORT_NODES.api)
      await page.getByTestId(`retry-import-document-${failedDocument.id}`).click()
      await expect
        .poll(async () => countCompletedContentFetches(request, EXTERNAL_IMPORT_NODES.api), {
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
      // Hold the body response until deletion, independent of worker scheduling.
      await configureMockImport(request, {
        pausedContentNodeIds: [EXTERNAL_IMPORT_NODES.product],
      })

      let documentId: number
      try {
        const imported = await importViaApi(request, context.token, context.knowledgeBaseId, [
          EXTERNAL_IMPORT_NODES.product,
        ])
        expect(imported.created).toHaveLength(1)
        documentId = imported.created[0].id
        await expect
          .poll(async () => (await configureMockImport(request, {})).waitingContentNodeIds, {
            timeout: 30_000,
            message: 'The worker must reach the held body request before deletion',
          })
          .toContain(EXTERNAL_IMPORT_NODES.product)
        await deleteDocument(request, context.token, documentId)
      } finally {
        await configureMockImport(request, { pausedContentNodeIds: [] })
      }

      // The late task fetched the content but must not resurrect the document:
      // keep probing the deleted record while the delayed fetch settles.
      await expect
        .poll(async () => countCompletedContentFetches(request, EXTERNAL_IMPORT_NODES.product), {
          timeout: 30_000,
          message: 'The in-flight task should complete the external body fetch',
        })
        .toBeGreaterThan(0)
      // The provider response is complete. Keep the deleted record under
      // observation while the worker finishes its guarded attachment write.
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

async function countCompletedContentFetches(
  request: APIRequestContext,
  nodeId: string
): Promise<number> {
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
