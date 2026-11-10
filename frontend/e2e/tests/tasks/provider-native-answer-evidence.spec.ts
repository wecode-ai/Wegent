import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { expect, test } from '@playwright/test'
import { resolveEvidenceResponseContent } from '../../utils/mock-answer-evidence'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'
import { createExternalImportRetrieval } from '../../utils/external-import-retrieval'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import {
  PROVIDER_NATIVE_API_URL as API,
  PROVIDER_NATIVE_MOCK_URL as MOCK,
  waitForTaskTerminal,
  openProviderNativeChat,
  clearToolScenario,
  getScenarioModelBodies,
} from '../../utils/provider-native-test-support'

// Only model services are simulated: native storage, indexing, MCP and HTTP are real.
test('native RAG answer keeps its committed snapshot across refresh and opens current original', async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  const client = createApiClient(request)
  const login = await client.login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data!.access_token
  const headers = createBackendRequestHeaders(token)
  const name = `e2e-evidence-${Date.now()}`
  const prompt = `${name}：项目上线日期是什么？`
  const retrieval = await createExternalImportRetrieval(request)
  const cleanup: string[] = []
  const create = async (path: string, data: unknown) => {
    const response = await request.post(`${API}${path}`, { headers, data })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  let taskId: number | undefined
  try {
    await create('/api/v1/namespaces/default/models', {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: { name, namespace: 'default' },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: 'mock-evidence',
            api_key: 'mock-key',
            base_url: `${MOCK}/v1`,
          },
        },
      },
    })
    cleanup.push(`/api/v1/namespaces/default/models/${name}`)
    const bot = await create('/api/bots', {
      name,
      shell_name: 'Chat',
      namespace: 'default',
      is_active: true,
      agent_config: { bind_model: name, bind_model_type: 'user' },
      system_prompt: 'Use native RAG search and cite its evidence_id.',
    })
    cleanup.push(`/api/v1/namespaces/default/bots/${name}`)
    const team = await create('/api/teams', {
      name,
      namespace: 'default',
      is_active: true,
      bind_mode: ['chat'],
      bots: [{ bot_id: bot.id, bot_prompt: '', role: 'worker' }],
    })
    cleanup.push(`/api/v1/namespaces/default/teams/${name}`)
    const kb = await create('/api/knowledge-bases', {
      name,
      namespace: 'default',
      kb_type: 'classic',
      summary_enabled: false,
      retrieval_config: retrieval.config,
      rag_config_mode: 'auto',
      allow_document_download: false,
    })
    cleanup.push(`/api/knowledge-bases/${kb.id}`)
    const text = 'EVIDENCE-SNAPSHOT-2026：项目上线日期为十一月十日。'
    const doc = await create('/api/knowledge/documents', {
      knowledge_base_id: kb.id,
      source_type: 'text',
      name: `${name}.txt`,
      content: text,
    })
    cleanup.push(`/api/knowledge-documents/${doc.id}`)
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API}/api/knowledge-documents/${doc.id}`, {
            headers,
          })
          expect(response.ok(), await response.text()).toBeTruthy()
          return (await response.json()).index_status
        },
        { timeout: 120000 }
      )
      .toBe('success')
    const scenario = await request.post(`${MOCK}/tool-scenarios`, {
      data: {
        matchText: prompt,
        steps: [
          {
            toolCalls: [
              {
                toolName: 'wegent_kb_search_knowledge_base',
                arguments: { knowledge_base_id: kb.id, query: '项目上线日期' },
              },
            ],
          },
          { responseContent: '项目十一月十日上线。{{answer_evidence}}' },
        ],
      },
    })
    expect(scenario.ok(), await scenario.text()).toBeTruthy()
    await openProviderNativeChat(page, { teamId: team.id, teamName: name })
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectWholeKnowledgeBase(kb.id, name)
    await knowledge.sendMessage(prompt)
    taskId = await knowledge.waitForTaskId()
    await waitForTaskTerminal(token, taskId)
    const citation = page.locator('[data-testid^="answer-citation-"]').first()
    await expect(citation).toBeVisible({ timeout: 30000 })
    const id = await citation.getAttribute('data-testid')
    await citation.click()
    await expect(page.getByTestId('answer-evidence-content')).toContainText(text)
    await page.reload()
    await page.getByTestId(id!).first().click()
    await expect(page.getByTestId('answer-evidence-content')).toContainText(text)
    const update = await request.put(`${API}/api/knowledge/documents/${doc.id}/content`, {
      headers,
      data: { content: 'CURRENT-ORIGINAL：项目日期已更新。' },
    })
    expect(update.ok(), await update.text()).toBeTruthy()
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API}/api/knowledge-documents/${doc.id}`, {
            headers,
          })
          expect(response.ok(), await response.text()).toBeTruthy()
          const current = await response.json()
          return current.index_status === 'success' && current.is_active === true
        },
        { timeout: 120000 }
      )
      .toBe(true)
    await page.getByTestId('answer-evidence-close').click()
    await page.getByTestId(id!).first().click()
    await expect(page.getByTestId('answer-evidence-content')).toContainText(text)
    const detail = page.waitForResponse(
      response => response.url().includes(`/documents/${doc.id}/detail`) && response.ok()
    )
    await page.getByTestId('answer-evidence-open-original').click()
    await detail
    await expect(
      page.getByText('CURRENT-ORIGINAL：项目日期已更新。', { exact: false })
    ).toBeVisible()
    await expect(page.getByTestId('knowledge-source-preview-download')).toHaveCount(0)

    // Reopening must reauthorize the source while answer access remains granted.
    const recipient = createApiClient(request)
    const recipientLogin = await recipient.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    expect(recipientLogin.status).toBe(200)
    const identity = await recipient.get<{ id: number }>('/api/users/me')
    expect(identity.status).toBe(200)
    const membership = { user_id: identity.data!.id, role: 'Reporter' }
    await create(`/api/share/Task/${taskId}/members`, membership)
    const sourceMember = await create(`/api/share/KnowledgeBase/${kb.id}/members`, membership)
    const recipientToken = recipientLogin.data!.access_token
    const context = await browser.newContext({
      baseURL,
      storageState: buildStorageState(baseURL!, recipientToken, getJwtExpiryMs(recipientToken)),
    })
    try {
      const viewer = await context.newPage()
      await viewer.goto(page.url())
      const viewerCitation = viewer.getByTestId(id!).first()
      await viewerCitation.click()
      await expect(viewer.getByTestId('answer-evidence-content')).toContainText(text)
      const revoked = await request.delete(
        `${API}/api/share/KnowledgeBase/${kb.id}/members/${sourceMember.id}`,
        { headers }
      )
      expect(revoked.ok(), await revoked.text()).toBeTruthy()
      await viewer.getByTestId('answer-evidence-close').click()
      const denied = viewer.waitForResponse(
        response =>
          response.url().includes('/knowledge-bases/citations/') && response.status() === 403
      )
      await viewerCitation.click()
      expect((await denied).status()).toBe(403)
      await expect(viewer.getByTestId('answer-evidence-content')).toHaveCount(0)
      await expect(viewer.getByTestId('answer-evidence-panel').getByRole('alert')).toBeVisible()
    } finally {
      await context.close()
    }
  } finally {
    await clearToolScenario(request, prompt)
    if (taskId) await request.delete(`${API}/api/tasks/${taskId}`, { headers })
    for (const path of cleanup.reverse()) {
      const response = await request.delete(`${API}${path}`, { headers })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    await retrieval.cleanup(request)
  }
})

// Multi-reference grey states are model-marker failures, not SQL fault coverage.
test('multiple searches keep same-title documents distinct across grey refresh and retry', async ({
  page,
  request,
}) => {
  test.setTimeout(180000)
  const login = await createApiClient(request).login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data!.access_token
  const headers = createBackendRequestHeaders(token)
  const name = `e2e-evidence-multi-${Date.now()}`
  const prompt = `${name} 核对两份同名资料`
  const retryPrompt = `${name} 重试后重新核对`
  const retrieval = await createExternalImportRetrieval(request)
  const cleanup: string[] = []
  const socket = createAuthenticatedSocketClient({
    socketBaseUrl: () => API,
    getToken: () => token,
  })
  const create = async (path: string, data: unknown) => {
    const response = await request.post(`${API}${path}`, { headers, data })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  let taskId: number | undefined
  try {
    await create('/api/v1/namespaces/default/models', {
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Model',
      metadata: { name, namespace: 'default' },
      spec: {
        modelConfig: {
          env: {
            model: 'openai',
            model_id: 'mock-evidence-multi',
            api_key: 'mock-key',
            base_url: `${MOCK}/v1`,
          },
        },
      },
    })
    cleanup.push(`/api/v1/namespaces/default/models/${name}`)
    const bot = await create('/api/bots', {
      name,
      shell_name: 'Chat',
      namespace: 'default',
      is_active: true,
      agent_config: { bind_model: name, bind_model_type: 'user' },
      system_prompt: 'Use native RAG and cite only current evidence_id.',
    })
    cleanup.push(`/api/v1/namespaces/default/bots/${name}`)
    const team = await create('/api/teams', {
      name,
      namespace: 'default',
      is_active: true,
      bind_mode: ['chat'],
      bots: [{ bot_id: bot.id, bot_prompt: '', role: 'worker' }],
    })
    cleanup.push(`/api/v1/namespaces/default/teams/${name}`)
    const kb = await create('/api/knowledge-bases', {
      name,
      namespace: 'default',
      kb_type: 'classic',
      summary_enabled: false,
      retrieval_config: retrieval.config,
      rag_config_mode: 'auto',
      allow_document_download: false,
    })
    cleanup.push(`/api/knowledge-bases/${kb.id}`)
    const docs: Array<{ id: number; text: string }> = []
    for (const [index, text] of [
      'ALPHA 项目上线日期十一月十日。',
      'BETA 项目负责人李四。',
    ].entries()) {
      const folder = await create(`/api/knowledge-bases/${kb.id}/folders`, {
        name: `folder-${index}`,
        parent_id: 0,
      })
      const doc = await create('/api/knowledge/documents', {
        knowledge_base_id: kb.id,
        folder_id: folder.id,
        source_type: 'text',
        name: '同名资料.txt',
        content: text,
      })
      cleanup.push(`/api/knowledge-documents/${doc.id}`)
      docs.push({ id: doc.id, text })
      await expect
        .poll(
          async () => {
            const response = await request.get(`${API}/api/knowledge-documents/${doc.id}`, {
              headers,
            })
            expect(response.ok(), await response.text()).toBeTruthy()
            return (await response.json()).index_status
          },
          { timeout: 120000 }
        )
        .toBe('success')
    }
    const searchSteps = docs.map(doc => ({
      toolCalls: [
        {
          toolName: 'wegent_kb_search_knowledge_base',
          arguments: { knowledge_base_id: kb.id, query: doc.text, max_results: 2 },
        },
      ],
    }))
    const scenario = async (matchText: string, responseContent: string, doneDelayMs = 0) => {
      const response = await request.post(`${MOCK}/tool-scenarios`, {
        data: { matchText, steps: [...searchSteps, { responseContent, doneDelayMs }] },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    await scenario(
      prompt,
      '多资料{{answer_evidence_all}} 重复{{answer_evidence}} 坏引用[[evidence:unknown-generation]][[citation:123]]'
    )
    await openProviderNativeChat(page, { teamId: team.id, teamName: name })
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectWholeKnowledgeBase(kb.id, name)
    await knowledge.sendMessage(prompt)
    taskId = await knowledge.waitForTaskId()
    await waitForTaskTerminal(token, taskId)
    const buttons = page.locator('[data-testid^="answer-citation-"]')
    await expect(buttons.first()).toBeVisible({ timeout: 30000 })
    const ids = [
      ...new Set(
        await buttons.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!))
      ),
    ]
    expect(ids.length).toBeGreaterThanOrEqual(2)
    const seenDocuments = new Set<number>()
    for (const id of ids) {
      const responsePromise = page.waitForResponse(
        response =>
          response.url().includes(`/citations/${id.replace('answer-citation-', '')}?`) &&
          response.ok()
      )
      await page.getByTestId(id).first().click()
      const snapshot = await (await responsePromise).json()
      seenDocuments.add(snapshot.document_id)
      expect(snapshot.content).toContain(docs.find(doc => doc.id === snapshot.document_id)!.text)
      await expect(page.getByTestId('answer-evidence-content')).toHaveText(snapshot.content)
      await page.getByTestId('answer-evidence-close').click()
    }
    expect([...seenDocuments].sort()).toEqual(docs.map(doc => doc.id).sort())
    await page.reload()
    for (const id of ids) await expect(page.getByTestId(id).first()).toBeVisible()
    await expect(page.getByTestId('answer-evidence-unavailable')).toHaveCount(2)
    let greyRequests = 0
    const countReads = (req: import('@playwright/test').Request) => {
      if (req.url().includes('/citations/')) greyRequests++
    }
    page.on('request', countReads)
    await page.getByTestId('answer-evidence-unavailable').first().click()
    expect(greyRequests).toBe(0)
    page.off('request', countReads)

    // Cancel a real in-flight generation, then retry that same answer via its public WS protocol.
    await clearToolScenario(request, prompt)
    await scenario(retryPrompt, '未提交{{answer_evidence_all}}', 30000)
    await knowledge.sendMessage(retryPrompt)
    await expect(page.getByText('未提交', { exact: false }).first()).toBeVisible({ timeout: 30000 })
    const beforeResponse = await request.get(`${API}/api/tasks/${taskId}`, { headers })
    expect(beforeResponse.ok()).toBeTruthy()
    const before = (await beforeResponse.json()) as EvidenceTask
    const answer = [...before.subtasks].reverse().find(row => row.role === 'ASSISTANT')
    expect(answer).toBeTruthy()
    const cancelled = await request.post(`${API}/api/tasks/${taskId}/cancel`, { headers })
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy()
    await waitForTaskTerminal(token, taskId, /^CANCELLED/)
    const captured = await getScenarioModelBodies(request, retryPrompt)
    const previousMarkers = resolveEvidenceResponseContent('{{answer_evidence_all}}', captured)!
    const previousMarker = previousMarkers.match(/\[\[evidence:[^\]]+\]\]/g)!.at(-1)!
    await scenario(retryPrompt, `重试完成{{answer_evidence_all}}${previousMarker}`)
    await socket.ensureConnected()
    const ack = await socket
      .getRawSocket()!
      .timeout(15000)
      .emitWithAck('chat:retry', { task_id: taskId, subtask_id: answer!.id })
    expect(ack.success, JSON.stringify(ack)).toBe(true)
    await waitForTaskTerminal(token, taskId)
    await page.reload()
    await expect(page.getByText('重试完成', { exact: false }).first()).toBeVisible()
    const afterResponse = await request.get(`${API}/api/tasks/${taskId}`, { headers })
    expect(afterResponse.ok()).toBeTruthy()
    const after = (await afterResponse.json()) as EvidenceTask
    const retried = after.subtasks.find(row => row.id === answer!.id)!
    expect(retried.result.answer_citations.length).toBeGreaterThanOrEqual(2)
    expect(retried.result.value).toContain('[[evidence-unavailable]]')
    const firstResponse = await request.get(`${API}/api/tasks/${taskId}`, { headers })
    const firstAnswer = ((await firstResponse.json()) as EvidenceTask).subtasks.find(
      row => row.id !== answer!.id && row.result?.answer_citations?.length
    )!
    expect(retried.result.answer_generation_id).not.toBe(firstAnswer.result.answer_generation_id)
    for (const item of retried.result.answer_citations) {
      const path = `${API}/api/knowledge-bases/citations/${item.citation_id}?answer_id=${answer!.id}&generation_id=${retried.result.answer_generation_id}`
      const response = await request.get(path, { headers })
      expect(response.status()).toBe(200)
      const cross = await request.get(
        path.replace(retried.result.answer_generation_id, firstAnswer.result.answer_generation_id),
        { headers }
      )
      expect(cross.status()).toBe(404)
    }
  } finally {
    socket.dispose()
    await clearToolScenario(request, prompt)
    await clearToolScenario(request, retryPrompt)
    if (taskId) await request.delete(`${API}/api/tasks/${taskId}`, { headers })
    for (const path of cleanup.reverse()) {
      const response = await request.delete(`${API}${path}`, { headers })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    await retrieval.cleanup(request)
  }
})

interface EvidenceTask {
  subtasks: Array<{
    id: number
    role: string
    result: {
      value: string
      answer_generation_id: string
      answer_citations: Array<{ citation_id: string }>
    }
  }>
}
