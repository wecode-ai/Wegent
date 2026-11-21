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
  getToolScenarioState,
} from '../../utils/provider-native-test-support'

// Only model services are simulated: native storage, indexing, MCP and HTTP are real.
test('API native RAG does not issue evidence and stays unchanged when opened on Web', async ({
  page,
  request,
}) => {
  test.setTimeout(180000)
  const login = await createApiClient(request).login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data!.access_token
  const headers = createBackendRequestHeaders(token)
  const name = `e2e-api-evidence-off-${Date.now()}`
  const prompt = `${name} search the original project date`
  const answer = `API-ANSWER-${name}`
  const text = `API-ORIGINAL-${name}: the project date is November 10.`
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
            model_id: 'mock-evidence-off',
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
      system_prompt: 'Search the native knowledge base and answer the question.',
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
    })
    cleanup.push(`/api/knowledge-bases/${kb.id}`)
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
                arguments: { knowledge_base_id: kb.id, query: 'project date' },
              },
            ],
          },
          { responseContent: answer },
        ],
      },
    })
    expect(scenario.ok(), await scenario.text()).toBeTruthy()
    const response = await create('/api/v1/responses', {
      model: `default#${name}`,
      input: prompt,
      stream: false,
      background: true,
      tools: [
        { type: 'wegent_chat_bot' },
        { type: 'knowledge_base', knowledge_base_names: [`default#${name}`] },
      ],
      // Public fields cannot activate a server-owned execution capability.
      enable_answer_evidence: true,
      client_origin: 'frontend',
      metadata: { enable_answer_evidence: true },
    })
    expect(response.id).toMatch(/^resp_\d+$/)
    taskId = Number(response.id.slice('resp_'.length))
    await waitForTaskTerminal(token, taskId)
    const completed = await request.get(`${API}/api/v1/responses/${response.id}`, { headers })
    expect(completed.ok(), await completed.text()).toBeTruthy()
    const completedBody = JSON.stringify(await completed.json())
    expect(completedBody).toContain(answer)
    for (const field of ['_answer_evidence', 'answer_citations', 'answer_evidence_errors']) {
      expect(completedBody).not.toContain(field)
    }
    const bodies = JSON.stringify(await getScenarioModelBodies(request, prompt))
    expect(bodies).toContain(text)
    for (const forbidden of ['evidence_id', 'evidence_instruction', '[[evidence:']) {
      expect(bodies).not.toContain(forbidden)
    }
    const checkSavedAnswer = async () => {
      const detail = await request.get(`${API}/api/tasks/${taskId}`, { headers })
      expect(detail.ok(), await detail.text()).toBeTruthy()
      const subtasks = (await detail.json()).subtasks as Array<{
        role: string
        result: Record<string, unknown>
      }>
      const saved = subtasks.filter(row => row.role === 'ASSISTANT').at(-1)!.result
      expect(saved.value).toBe(answer)
      for (const field of [
        '_answer_evidence',
        'answer_generation_id',
        'answer_citations',
        'answer_evidence_errors',
      ]) {
        expect(saved).not.toHaveProperty(field)
      }
    }
    await checkSavedAnswer()
    await page.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
    await page.goto(`/chat?taskId=${taskId}&teamId=${team.id}`)
    await expect(page.getByText(answer, { exact: true }).first()).toBeVisible()
    await expect(page.locator('[data-testid^="answer-citation-"]')).toHaveCount(0)
    await page.reload()
    await expect(page.getByText(answer, { exact: true }).first()).toBeVisible()
    await expect(page.locator('[data-testid^="answer-citation-"]')).toHaveCount(0)
    await checkSavedAnswer()
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

test('native RAG answer keeps its committed snapshot across refresh and opens current original', async ({
  page,
  request,
  browser,
  baseURL,
}) => {
  test.setTimeout(180000)
  await page.setViewportSize({ width: 1440, height: 900 })
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
    const bot = await create('/api/bots', {
      name,
      shell_name: 'Chat',
      namespace: 'default',
      is_active: true,
      agent_config: { bind_model: name, bind_model_type: 'user' },
      system_prompt: 'Use native RAG search and cite its evidence_id.',
      default_knowledge_base_refs: [{ id: kb.id, name }],
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
    await citation.hover()
    await expect(page.getByTestId('answer-evidence-preview-content')).toContainText(text)
    await page.getByTestId('message-input').hover()
    await expect(page.getByTestId('answer-evidence-preview')).toHaveCount(0)
    await page.getByTestId('message-input').press('Tab')
    await citation.focus()
    await expect(page.getByTestId('answer-evidence-preview-content')).toContainText(text)
    await citation.press('Enter')
    const panel = page.getByTestId('answer-evidence-panel')
    await expect(panel).toHaveAttribute('data-layout', 'side')
    await expect(panel).toHaveAttribute('data-version-status', 'unknown')
    await expect(page.getByTestId('answer-evidence-content')).toContainText(text)
    await page.getByTestId('answer-evidence-close').press('Escape')
    await expect(citation).toBeFocused()
    await expect(panel).toHaveCount(0)
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
    await page.getByTestId('answer-evidence-close').click()
    await page.setViewportSize({ width: 900, height: 900 })
    const originalReads: string[] = []
    page.on('request', req => {
      if (/knowledge-documents|\/documents\/\d+\/detail|document-protection/.test(req.url())) {
        originalReads.push(req.url())
      }
    })
    await page.getByTestId(id!).first().click()
    await expect(panel).toHaveAttribute('data-layout', 'overlay')
    await expect(page.getByTestId('answer-evidence-content')).toContainText(text)
    expect(originalReads).toEqual([])
    const detail = page.waitForResponse(
      response => response.url().includes(`/documents/${doc.id}/detail`) && response.ok()
    )
    await page.getByTestId('answer-evidence-open-original').click()
    await detail
    await expect(
      page.getByText('CURRENT-ORIGINAL：项目日期已更新。', { exact: false })
    ).toBeVisible()
    await expect(page.getByTestId('knowledge-source-preview-download')).toHaveCount(0)

    await expect(page.getByTestId('answer-original-download')).toHaveCount(0)
    await expect(page.getByTestId('answer-original-file')).toHaveCount(0)
    await expect(panel).toHaveAttribute('data-version-status', 'unknown')
    await page.getByTestId('answer-evidence-return-fragment').click()
    await expect(page.getByTestId('answer-evidence-content')).toContainText(text)

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
      await context.addInitScript(() => {
        localStorage.setItem('user_onboarding_completed', 'true')
      })
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
      await expect(viewer.getByTestId('answer-evidence-panel')).toHaveCount(0)
      await expect(viewerCitation).toHaveCount(0)
      await expect(viewer.getByTestId('answer-source-access')).toBeVisible()

      await create(`/api/share/Team/${team.id}/members`, membership)
      const restrictedHeaders = createBackendRequestHeaders(recipientToken)
      const permission = await request.get(
        `${API}/api/share/KnowledgeBase/${kb.id}/my-permission?task_id=${taskId}`,
        { headers: restrictedHeaders }
      )
      expect(permission.ok(), await permission.text()).toBeTruthy()
      expect((await permission.json()).source_access).toBe('visit-only')
      const sourceReads: string[] = []
      viewer.on('request', req => {
        if (
          /\/citations\/|knowledge-documents|\/documents\/\d+\/detail|document-protection/.test(
            req.url()
          )
        ) {
          sourceReads.push(req.url())
        }
      })
      await viewer.reload()
      await expect(viewer.getByText('项目十一月十日上线。', { exact: false }).first()).toBeVisible()
      await expect(viewer.getByTestId('answer-source-access')).toHaveCount(1)
      await expect(viewer.locator('[data-testid^="answer-citation-"]')).toHaveCount(0)
      await expect(viewer.getByTestId('answer-evidence-unavailable')).toHaveCount(0)
      await expect(viewer.getByTestId('answer-evidence-summary')).toHaveCount(0)
      expect(sourceReads).toEqual([])
      const { search } = new URL((await denied).url())
      const citationId = id!.replace('answer-citation-', '')
      const restrictedCitation = await request.get(
        `${API}/api/knowledge-bases/citations/${citationId}${search}`,
        { headers: restrictedHeaders }
      )
      expect(restrictedCitation.status()).toBe(403)
      expect(await restrictedCitation.json()).toMatchObject({
        detail: { code: 'CITATION_ACCESS_DENIED', denied_scope: 'source' },
      })
      const content = await request.get(`${API}/api/knowledge/documents/${doc.id}/content`, {
        headers: restrictedHeaders,
      })
      expect(content.status()).toBe(403)
      await expect(page.getByTestId('answer-evidence-content')).toContainText(text)
    } finally {
      await context.close()
    }
    const phone = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      storageState: buildStorageState(baseURL!, token, getJwtExpiryMs(token)),
    })
    try {
      await phone.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
      const mobile = await phone.newPage()
      await mobile.goto(page.url())
      await mobile.getByTestId(id!).first().tap()
      const fullScreen = mobile.getByTestId('answer-evidence-panel')
      await expect(fullScreen).toHaveAttribute('data-layout', 'mobile')
      await expect(mobile.getByTestId('answer-evidence-content')).toContainText(text)
      // The shared dialog animates in before it settles on the viewport edges.
      await expect
        .poll(() => fullScreen.boundingBox())
        .toEqual({
          x: 0,
          y: 0,
          width: 390,
          height: 844,
        })
      await mobile.getByTestId('answer-evidence-close').tap()
      await expect(fullScreen).toHaveCount(0)
    } finally {
      await phone.close()
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
      bind_mode: ['chat', 'knowledge'],
      bots: [{ bot_id: bot.id, bot_prompt: '', role: 'worker' }],
    })
    cleanup.push(`/api/v1/namespaces/default/teams/${name}`)
    const kb = await create('/api/knowledge-bases', {
      name,
      namespace: 'default',
      kb_type: 'notebook',
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
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.addInitScript(teamId => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.setItem('wegent_last_team_id_knowledge', String(teamId))
    }, team.id)
    await page.goto(`/knowledge/document/${kb.id}?view=notebook&teamId=${team.id}`)
    await expect(page.getByTestId('knowledge-detail-notebook')).toBeVisible()
    const chat = page.getByTestId('knowledge-workspace-chat')
    await expect(chat).toBeVisible()
    const sources = page.getByTestId('knowledge-source-panel')
    await expect(sources).toBeVisible()
    const knowledge = new ProviderNativeKnowledgePage(page)
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
    expect(await buttons.count()).toBeGreaterThan(ids.length)
    await sources.getByTitle('folder-0', { exact: true }).click()
    const sourceFolder = sources
      .getByTestId('document-source-breadcrumb-row')
      .getByText('folder-0', { exact: true })
    await expect(sourceFolder).toBeVisible()
    const selectedSource = sources.getByRole('checkbox')
    await expect(selectedSource).toHaveCount(1)
    await expect(selectedSource).not.toBeChecked()
    await selectedSource.click()
    await expect(selectedSource).toBeChecked()

    const input = chat.getByTestId('message-input')
    const generationDraft = '用选中的资料生成一份上线进度简报。'
    await input.fill(generationDraft)
    await expect(input).toHaveText(generationDraft)
    const generationPanel = page.getByTestId('knowledge-generation-panel')
    await expect(generationPanel).toBeVisible()
    const userMessage = chat.getByText(prompt, { exact: true })
    const answerText = chat.getByText('多资料', { exact: false }).first()
    await expect(userMessage).toBeVisible()
    await expect(answerText).toBeVisible()

    const first = page.getByTestId(ids[0]).first()
    await first.hover()
    await expect(page.getByTestId('answer-evidence-preview-content')).toBeVisible()
    const panel = page.getByTestId('answer-evidence-panel')
    const fragment = panel.getByTestId('answer-evidence-select-fragment')
    const excerpt = panel.getByTestId('answer-evidence-content')
    const firstCitationId = ids[0].replace('answer-citation-', '')
    const waitForFragment = (citationId: string) =>
      page.waitForResponse(
        response => response.url().includes(`/citations/${citationId}?`) && response.ok()
      )
    const firstLoad = waitForFragment(firstCitationId)
    await first.click()
    const openedPanel = await panel.elementHandle()
    const seenDocuments = new Set<number>()
    let firstExcerpt = ''
    for (const [index, id] of ids.entries()) {
      const citationId = id.replace('answer-citation-', '')
      const loaded = index === 0 ? firstLoad : waitForFragment(citationId)
      if (index > 0) await fragment.selectOption(citationId)
      const snapshot = await (await loaded).json()
      seenDocuments.add(snapshot.document_id)
      expect(snapshot.content).toContain(docs.find(doc => doc.id === snapshot.document_id)!.text)
      await expect(panel).toHaveCount(1)
      await expect(panel).toHaveAttribute('data-layout', 'side')
      await expect(fragment).toHaveValue(citationId)
      await expect(excerpt).toHaveText(snapshot.content)
      if (index === 0) firstExcerpt = snapshot.content
      await expect(selectedSource).toBeChecked()
    }
    expect([...seenDocuments].sort()).toEqual(docs.map(doc => doc.id).sort())
    await expect(generationPanel).toBeHidden()
    await fragment.selectOption(firstCitationId)
    await expect(excerpt).toHaveText(firstExcerpt)
    expect(await openedPanel?.evaluate(node => node.isConnected)).toBe(true)
    const savedExcerpt = await excerpt.innerText()
    await page.getByTestId('answer-evidence-open-original').click()
    await expect(panel.getByText(savedExcerpt, { exact: false })).toBeVisible()
    await page.getByTestId('answer-evidence-return-fragment').click()
    await expect(excerpt).toHaveText(savedExcerpt)
    await page.getByTestId('answer-evidence-close').click()
    await expect(first).toBeFocused()
    await expect(sources).toBeVisible()
    await expect(selectedSource).toBeChecked()
    await expect(sourceFolder).toBeVisible()
    await expect(generationPanel).toBeVisible()
    await expect(userMessage).toBeVisible()
    await expect(answerText).toBeVisible()
    await expect(input).toHaveText(generationDraft)
    expect(await knowledge.waitForTaskId()).toBe(taskId)
    await generationPanel.getByTestId('artifact-type-briefing').click()
    const generationDialog = page.getByTestId('artifact-create-dialog')
    await expect(generationDialog).toContainText(
      /1 selected documents will be used|将使用已选中的 1 篇文档/
    )
    await generationDialog.getByTestId('artifact-create-cancel').click()
    await expect(input).toHaveText(generationDraft)
    await input.fill('')
    await page.reload()
    await expect(page.getByTestId('knowledge-workspace-chat')).toBeVisible()
    await first.click()
    await expect(excerpt).toHaveText(savedExcerpt)
    await page.getByTestId('answer-evidence-close').click()
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
    // Cancel the new Chat stream before the final retry.
    await scenario(retryPrompt, '重试中未提交的回答{{answer_evidence_all}}', 30000)
    await socket.ensureConnected()
    const intermediateRetry = await socket
      .getRawSocket()!
      .timeout(15000)
      .emitWithAck('chat:retry', { task_id: taskId, subtask_id: answer!.id })
    expect(intermediateRetry.success, JSON.stringify(intermediateRetry)).toBe(true)
    // The retry ACK precedes stream startup. The last model step keeps the new stream active.
    await expect
      .poll(async () => (await getToolScenarioState(request, retryPrompt)).nextStep, {
        message: 'The new retry should reach its held-open model response before cancellation',
      })
      .toBe(searchSteps.length + 1)
    const cancelAck = await socket
      .getRawSocket()!
      .timeout(15000)
      .emitWithAck('chat:cancel', { subtask_id: answer!.id, shell_type: 'Chat' })
    expect(cancelAck).toEqual({ success: true, finalized: true })
    await waitForTaskTerminal(token, taskId, /^CANCELLED/)
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
