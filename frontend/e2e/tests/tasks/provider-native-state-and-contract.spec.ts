import { APIRequestContext, expect, Page, test } from '@playwright/test'
import { PROVIDER_NATIVE_MARKERS } from '../../fixtures/provider-native-knowledge'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import {
  authHeaders,
  clearToolScenario,
  collectTaskToolCalls,
  configureDingTalkService,
  configureToolScenario,
  createProviderNativeResources,
  deleteProviderNativeResources,
  extractExternalKnowledgeRefs,
  extractTaskAnswer,
  getMcpCalls,
  getScenarioModelBodies,
  getTask,
  modelRequestText,
  modelToolNames,
  openProviderNativeChat,
  PROVIDER_NATIVE_API_URL,
  PROVIDER_NATIVE_MOCK_URL,
  ProviderNativeResources,
  resetMockMcp,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const TEST_PREFIX = `e2e-provider-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DINGTALK_D1 = 'DING-D1-NATIVE-2026'
const READ_DOCUMENT_TOOL = 'wegent_kb_read_document_content'
const LIST_DOCUMENTS_TOOL = 'wegent_kb_list_documents'

test.describe.configure({ mode: 'serial' })

test.describe('Provider-native binding state and contracts', () => {
  let resources: ProviderNativeResources
  const prompts = new Set<string>()

  test.beforeAll(async ({ request }) => {
    resources = await createProviderNativeResources(request, TEST_PREFIX)
  })

  test.beforeEach(async ({ page, request }) => {
    await resetMockMcp(request)
    await openProviderNativeChat(page, resources)
  })

  test.afterEach(async ({ request }) => {
    await Promise.all(
      [...prompts].map(prompt => clearToolScenario(request, prompt).catch(() => null))
    )
    prompts.clear()
    await configureDingTalkService(request, resources.token, 'docs', true).catch(() => null)
  })

  test.afterAll(async ({ request }) => {
    await deleteProviderNativeResources(request, resources)
  })

  test('E2E-A2-012 guides DingTalk MCP configuration without fallback and recovers', async ({
    page,
    request,
  }) => {
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDingTalkDocuments(['doc-d1'])
    await configureDingTalkService(request, resources.token, 'docs', false)
    await request.post(`${PROVIDER_NATIVE_MOCK_URL}/clear-requests`)
    const missingPrompt = makePrompt('012-missing', '输出唯一断言标记。')
    const modalLink = 'wegent://modal/mcp-provider-config?provider=dingtalk&service=docs'
    await scenario(request, missingPrompt, [
      {
        responseContent: `当前会话还没有可用的钉钉文档 MCP。请点击 [打开钉钉文档 MCP 配置弹窗](${modalLink}) 完成配置。`,
      },
    ])
    const guidanceTask = await sendCurrentTask(page, request, missingPrompt)

    expect(await getMcpCalls(request)).toHaveLength(0)
    const missingBodies = await getScenarioModelBodies(request, missingPrompt)
    const missingRequestText = modelRequestText(missingBodies)
    const missingToolNames = modelToolNames(missingBodies)
    expect(missingBodies.length).toBeGreaterThan(0)
    expect(missingRequestText).toContain('Configuration Required')
    expect(missingRequestText).toContain(modalLink)
    expect(missingToolNames.some(name => name.includes('dingtalk-docs'))).toBe(false)
    expect(missingToolNames.some(name => /knowledge_search$/.test(name))).toBe(false)
    expect(extractTaskAnswer(guidanceTask)).toContain(modalLink)
    expect(extractTaskAnswer(guidanceTask)).not.toContain(DINGTALK_D1)
    await expect(page.getByRole('link', { name: '打开钉钉文档 MCP 配置弹窗' })).toHaveAttribute(
      'href',
      modalLink
    )

    await configureDingTalkService(request, resources.token, 'docs', true)
    const retryPrompt = makePrompt('012-retry', '输出唯一断言标记。')
    await scenario(request, retryPrompt, [
      toolStep('get_document_info', { nodeId: 'doc-d1' }),
      toolStep('get_document_content', { nodeId: 'doc-d1' }),
      { responseContent: DINGTALK_D1 },
    ])
    await page.goto(`/chat?teamId=${resources.teamId}`, { waitUntil: 'domcontentloaded' })
    await new ProviderNativeKnowledgePage(page).selectDingTalkDocuments(['doc-d1'])
    const retryTask = await sendCurrentTask(page, request, retryPrompt)
    expect(extractTaskAnswer(retryTask)).toBe(DINGTALK_D1)
  })

  test('E2E-A2-014 rejects every invalid external reference without mutating the Task', async ({
    page,
    request,
  }) => {
    const setupPrompt = makePrompt('014-setup', '只回复 READY。')
    await scenario(request, setupPrompt, [{ responseContent: 'READY' }])
    const task = await sendCurrentTask(page, request, setupPrompt)
    expect(extractTaskAnswer(task)).toBe('READY')
    const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    expect(taskId).toBeGreaterThan(0)
    const invalidRefs = [
      { provider: 'dingtalk', mode: 'all_accessible', id: 'space-d' },
      { provider: 'dingtalk', mode: 'explicit' },
      {
        provider: 'dingtalk',
        mode: 'explicit',
        id: 'space-d',
        target_type: 'database',
      },
    ]
    for (const ref of invalidRefs) {
      const response = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/tasks/${taskId}/external-knowledge-refs/remove`,
        {
          headers: authHeaders(resources.token),
          data: { ref },
        }
      )
      expect(response.status(), await response.text()).toBe(422)
    }
    const bindingsResponse = await request.get(
      `${PROVIDER_NATIVE_API_URL}/api/tasks/${taskId}/external-knowledge-refs`,
      { headers: authHeaders(resources.token) }
    )
    expect(bindingsResponse.status(), await bindingsResponse.text()).toBe(200)
    expect(await bindingsResponse.json()).toMatchObject({ items: [], total: 0 })
    expect(await getMcpCalls(request)).toHaveLength(0)
  })

  test('E2E-A2-015 persists then removes a DingTalk binding for subsequent turns', async ({
    page,
    request,
  }) => {
    const firstPrompt = makePrompt('015-bound', '只回复 BOUND。')
    await scenario(request, firstPrompt, [{ responseContent: 'BOUND' }])
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDingTalkDocuments(['doc-d1'])
    await knowledge.sendMessage(firstPrompt)
    const taskId = await knowledge.waitForTaskId()
    await waitForTaskTerminal(request, resources.token, taskId)

    const beforeResponse = await request.get(
      `${PROVIDER_NATIVE_API_URL}/api/tasks/${taskId}/external-knowledge-refs`,
      { headers: authHeaders(resources.token) }
    )
    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200)
    const before = (await beforeResponse.json()) as { items: Record<string, unknown>[] }
    expect(before.items).toHaveLength(1)

    const removeResponse = await request.post(
      `${PROVIDER_NATIVE_API_URL}/api/tasks/${taskId}/external-knowledge-refs/remove`,
      {
        headers: authHeaders(resources.token),
        data: { ref: before.items[0] },
      }
    )
    expect(removeResponse.status(), await removeResponse.text()).toBe(200)
    expect((await removeResponse.json()) as { total: number }).toMatchObject({ total: 0 })

    const secondPrompt = makePrompt('015-after-remove', '输出之前所选文档的唯一断言标记。')
    await scenario(request, secondPrompt, [{ responseContent: '当前没有已绑定的钉钉知识范围。' }])
    await page.goto(`/chat?teamId=${resources.teamId}&taskId=${taskId}`, {
      waitUntil: 'domcontentloaded',
    })
    const secondTask = await sendCurrentTask(page, request, secondPrompt, taskId)
    const bodies = await getScenarioModelBodies(request, secondPrompt)
    expect(modelRequestText(bodies)).not.toMatch(
      /<selected_knowledge_sources>[\s\S]*?<\/selected_knowledge_sources>/
    )
    expect(modelToolNames(bodies).some(name => name.includes('dingtalk-docs'))).toBe(false)
    expect(extractExternalKnowledgeRefs(secondTask)).toHaveLength(0)
    expect(await getMcpCalls(request)).toHaveLength(0)
    expect(extractTaskAnswer(secondTask)).toContain('没有已绑定')
  })

  test('E2E-A2-016 reuses one exact document binding on the next turn', async ({
    page,
    request,
  }) => {
    const firstPrompt = makePrompt('016-first', '输出唯一断言标记。')
    await scenario(request, firstPrompt, [
      toolStep(READ_DOCUMENT_TOOL, { document_id: resources.fixture.documents.a1.id }),
      { responseContent: PROVIDER_NATIVE_MARKERS.a1 },
    ])
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDocuments(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name,
      [resources.fixture.documents.a1.id]
    )
    await knowledge.sendMessage(firstPrompt)
    const taskId = await knowledge.waitForTaskId()
    await waitForTaskTerminal(request, resources.token, taskId)

    const secondPrompt = makePrompt('016-second', '所选文档的核心设计第 5 点是什么？')
    await scenario(request, secondPrompt, [
      toolStep(READ_DOCUMENT_TOOL, { document_id: resources.fixture.documents.a1.id }),
      {
        responseContent:
          'Chat Shell 与 ClaudeCode 使用相同的 selected_knowledge_sources 提示词结构。',
      },
    ])
    await page.goto(`/chat?teamId=${resources.teamId}&taskId=${taskId}`, {
      waitUntil: 'domcontentloaded',
    })
    const task = await sendCurrentTask(page, request, secondPrompt, taskId)
    const bodies = await getScenarioModelBodies(request, secondPrompt)
    const selection = modelRequestText(bodies)
    expect(count(selection, '<resource ')).toBe(bodies.length)
    expect(selection).toContain(`resource_id="${resources.fixture.documents.a1.id}"`)
    expect(selection).not.toContain(`resource_id="${resources.fixture.documents.a2.id}"`)
    expect(extractTaskAnswer(task)).toContain('相同的 selected_knowledge_sources')
  })

  test('E2E-A2-017 atomically replaces a document selection with the whole knowledge base', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('017', '输出所选知识库中每份文档的唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(LIST_DOCUMENTS_TOOL, { knowledge_base_id: resources.fixture.knowledgeBase.id }),
      {
        toolCalls: [
          resources.fixture.documents.a1,
          resources.fixture.documents.a2,
          resources.fixture.documents.a3,
        ].map(document => ({
          toolName: READ_DOCUMENT_TOOL,
          arguments: { document_id: document.id },
        })),
      },
      {
        responseContent: `${resources.fixture.documents.a1.name} ${PROVIDER_NATIVE_MARKERS.a1}\n${resources.fixture.documents.a2.name} ${PROVIDER_NATIVE_MARKERS.a2}\n${resources.fixture.documents.a3.name} ${PROVIDER_NATIVE_MARKERS.a3}`,
      },
    ])
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectDocuments(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name,
      [resources.fixture.documents.a1.id]
    )
    await knowledge.selectWholeKnowledgeBase(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name
    )
    const task = await sendCurrentTask(page, request, prompt)
    const text = modelRequestText(await getScenarioModelBodies(request, prompt))
    expect(text).toContain(`knowledge_base_id="${resources.fixture.knowledgeBase.id}"`)
    expect(text).not.toContain('<resource ')
    expect(
      collectTaskToolCalls(task).filter(call => call.name.endsWith(READ_DOCUMENT_TOOL))
    ).toHaveLength(3)
  })

  test('E2E-A2-018 atomically replaces a whole knowledge base with folder and document scopes', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('018', '按标题输出所选范围内每份文档的唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(LIST_DOCUMENTS_TOOL, {
        knowledge_base_id: resources.fixture.knowledgeBase.id,
        folder_id: resources.fixture.folders.requirements.id,
      }),
      {
        toolCalls: [
          resources.fixture.documents.a1,
          resources.fixture.documents.a2,
          resources.fixture.documents.a3,
        ].map(document => ({
          toolName: READ_DOCUMENT_TOOL,
          arguments: { document_id: document.id },
        })),
      },
      {
        responseContent: `${resources.fixture.documents.a1.name} ${PROVIDER_NATIVE_MARKERS.a1}\n${resources.fixture.documents.a2.name} ${PROVIDER_NATIVE_MARKERS.a2}\n${resources.fixture.documents.a3.name} ${PROVIDER_NATIVE_MARKERS.a3}`,
      },
    ])
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.selectWholeKnowledgeBase(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name
    )
    await knowledge.selectWholeKnowledgeBase(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name
    )
    await knowledge.selectFolder(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name,
      resources.fixture.folders.requirements.id
    )
    await knowledge.selectDocuments(
      resources.fixture.knowledgeBase.id,
      resources.fixture.knowledgeBase.name,
      [resources.fixture.documents.a3.id]
    )
    const task = await sendCurrentTask(page, request, prompt)
    const text = modelRequestText(await getScenarioModelBodies(request, prompt))
    expect(text).toContain(`resource_id="${resources.fixture.folders.requirements.id}"`)
    expect(text).toContain(`resource_id="${resources.fixture.documents.a3.id}"`)
    expect(text).not.toContain('scope_type="knowledge_base"')
    const answer = extractTaskAnswer(task)
    for (const document of [
      resources.fixture.documents.a1,
      resources.fixture.documents.a2,
      resources.fixture.documents.a3,
    ]) {
      expect(answer).toContain(document.name)
    }
  })

  test('E2E-A2-026 returns a warning and no data for an unknown provider', async ({ request }) => {
    const internalToken = process.env.E2E_INTERNAL_SERVICE_TOKEN || ''
    expect(internalToken).toBeTruthy()
    const response = await request.post(
      `${PROVIDER_NATIVE_API_URL}/api/internal/knowledge/list-documents`,
      {
        headers: {
          Authorization: `Bearer ${internalToken}`,
          'Content-Type': 'application/json',
        },
        data: {
          user_id: 1,
          external_knowledge_refs: [
            { provider: 'unknown-provider', mode: 'explicit', id: 'unknown-kb' },
          ],
        },
      }
    )
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as { documents: unknown[]; warnings: string[] }
    expect(body.documents).toEqual([])
    expect(body.warnings).toContain('Knowledge provider is not registered: unknown-provider')
    expect(await getMcpCalls(request)).toHaveLength(0)
  })

  test('E2E-A2-027 escapes XML names while tools keep raw numeric IDs', async ({
    page,
    request,
  }) => {
    const kbName = `${TEST_PREFIX}-KB-<&"'>`
    const documentName = `${TEST_PREFIX}-Doc-<&"'>.md`
    const marker = 'WEGENT-XML-SPECIAL-2026'
    const kbResponse = await request.post(`${PROVIDER_NATIVE_API_URL}/api/knowledge-bases`, {
      headers: authHeaders(resources.token),
      data: {
        name: kbName,
        description: 'XML escaping E2E fixture',
        namespace: 'default',
        kb_type: 'classic',
        rag_config_mode: 'disabled',
        summary_enabled: false,
      },
    })
    expect([200, 201]).toContain(kbResponse.status())
    const kb = (await kbResponse.json()) as { id: number; name: string }
    try {
      const documentResponse = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/knowledge/documents`,
        {
          headers: authHeaders(resources.token),
          data: {
            knowledge_base_id: kb.id,
            name: documentName,
            source_type: 'text',
            content: `# XML 特殊字符\n\n唯一断言标记：${marker}`,
            file_extension: 'md',
            folder_id: 0,
          },
        }
      )
      expect([200, 201]).toContain(documentResponse.status())
      const document = (await documentResponse.json()) as { id: number }
      const prompt = makePrompt('027', '输出唯一断言标记。')
      await scenario(request, prompt, [
        toolStep(READ_DOCUMENT_TOOL, { document_id: document.id }),
        { responseContent: marker },
      ])
      const knowledge = new ProviderNativeKnowledgePage(page)
      await knowledge.selectDocuments(kb.id, kb.name, [document.id])
      const task = await sendCurrentTask(page, request, prompt)
      const text = modelRequestText(await getScenarioModelBodies(request, prompt))
      expect(text).toContain('&lt;')
      expect(text).toContain('&amp;')
      expect(text).toContain('&quot;')
      expect(text).toContain('&#x27;')
      expect(count(text, '<source ')).toBeGreaterThan(0)
      expect(collectTaskToolCalls(task)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringMatching(new RegExp(`${READ_DOCUMENT_TOOL}$`)),
            input: { document_id: document.id },
          }),
        ])
      )
      expect(extractTaskAnswer(task)).toBe(marker)
    } finally {
      await request.delete(`${PROVIDER_NATIVE_API_URL}/api/knowledge-bases/${kb.id}`, {
        headers: authHeaders(resources.token),
      })
    }
  })

  async function scenario(
    request: APIRequestContext,
    prompt: string,
    steps: Parameters<typeof configureToolScenario>[2]
  ): Promise<void> {
    prompts.add(prompt)
    await configureToolScenario(request, prompt, steps)
  }

  async function sendCurrentTask(
    page: Page,
    request: APIRequestContext,
    prompt: string,
    expectedTaskId?: number
  ): Promise<unknown> {
    const knowledge = new ProviderNativeKnowledgePage(page)
    await knowledge.sendMessage(prompt)
    const taskId = await knowledge.waitForTaskId()
    if (expectedTaskId) expect(taskId).toBe(expectedTaskId)
    await waitForTaskTerminal(request, resources.token, taskId)
    return getTask(request, resources.token, taskId)
  }
})

function toolStep(toolName: string, args: Record<string, unknown>) {
  return { toolCalls: [{ toolName, arguments: args }] }
}

function makePrompt(caseId: string, prompt: string): string {
  return `${TEST_PREFIX} E2E-A2-${caseId} ${prompt}`
}

function count(value: string, fragment: string): number {
  return value.split(fragment).length - 1
}
