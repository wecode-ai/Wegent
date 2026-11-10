import { expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'
import { createExternalImportRetrieval } from '../../utils/external-import-retrieval'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import {
  PROVIDER_NATIVE_API_URL as API,
  PROVIDER_NATIVE_MOCK_URL as MOCK,
  waitForTaskTerminal,
  openProviderNativeChat,
  clearToolScenario,
} from '../../utils/provider-native-test-support'

// Only model services are simulated: native storage, indexing, MCP and HTTP are real.
test('native RAG answer keeps its committed snapshot across refresh and opens current original', async ({
  page,
  request,
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
