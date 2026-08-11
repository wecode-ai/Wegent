import { APIRequestContext, expect, Page, test } from '@playwright/test'
import { PROVIDER_NATIVE_MARKERS } from '../../fixtures/provider-native-knowledge'
import { ProviderNativeKnowledgePage } from '../../pages/tasks/provider-native-knowledge.page'
import {
  clearToolScenario,
  collectTaskToolCalls,
  configureDingTalkService,
  configureMockMcp,
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
  ProviderNativeResources,
  resetMockMcp,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const TEST_PREFIX = `e2e-provider-dingtalk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DINGTALK_MARKERS = {
  d1: 'DING-D1-NATIVE-2026',
  d2: 'DING-D2-FEDERATED-2024',
  d3: 'DING-D3-PROJECT-ORION',
  m1: 'DING-M1-PERSONAL-ALPHA',
} as const
const INFO_TOOL = 'get_document_info'
const CONTENT_TOOL = 'get_document_content'
const LIST_TOOL = 'list_nodes'
const SEARCH_TOOL = 'search_documents'
const RENAME_TOOL = 'rename_document'

test.describe.configure({ mode: 'serial' })

test.describe('Provider-native DingTalk and multi-provider access', () => {
  let resources: ProviderNativeResources
  let activePrompt = ''

  test.beforeAll(async ({ request }) => {
    resources = await createProviderNativeResources(request, TEST_PREFIX)
  })

  test.beforeEach(async ({ page, request }) => {
    activePrompt = ''
    await resetMockMcp(request)
    await openProviderNativeChat(page, resources)
  })

  test.afterEach(async ({ request }) => {
    if (activePrompt) await clearToolScenario(request, activePrompt).catch(() => null)
  })

  test.afterAll(async ({ request }) => {
    await deleteProviderNativeResources(request, resources)
  })

  test('E2E-A2-005 reads one exact DingTalk document', async ({ page, request }) => {
    const prompt = makePrompt('005', '输出唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-d1' }),
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d1' }),
      { responseContent: DINGTALK_MARKERS.d1 },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkDocuments(['doc-d1'])
    )

    const refs = extractExternalKnowledgeRefs(task)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      provider: 'dingtalk',
      id: 'space-d',
      target_type: 'document',
      node_id: 'doc-d1',
      document_id: 'doc-d1',
      resource_url: 'https://alidocs.dingtalk.com/i/nodes/doc-d1',
    })
    const evidence = await collectEvidence(request, prompt)
    expect(evidence.modelText).toContain('provider="dingtalk"')
    expect(evidence.modelText).toContain('resource_id="doc-d1"')
    expect(evidence.modelText).not.toContain('https://alidocs.dingtalk.com/i/nodes/doc-d1 输出')
    expectOnlyProviderCalls(evidence.mcpCalls, [INFO_TOOL, CONTENT_TOOL])
    expect(extractTaskAnswer(task)).toBe(DINGTALK_MARKERS.d1)
    await expect(page.getByTestId('messages-container')).toContainText(DINGTALK_MARKERS.d1)
  })

  test('E2E-A2-006 reads the selected DingTalk folder snapshot', async ({ page, request }) => {
    const prompt = makePrompt('006', '比较所选设计文档，并输出各自的唯一断言标记。')
    await scenario(request, prompt, [
      {
        toolCalls: ['doc-d1', 'doc-d2'].map(nodeId => ({
          toolName: INFO_TOOL,
          arguments: { nodeId },
        })),
      },
      {
        toolCalls: ['doc-d1', 'doc-d2'].map(nodeId => ({
          toolName: CONTENT_TOOL,
          arguments: { nodeId },
        })),
      },
      {
        responseContent: `Doc-D1_新设计 ${DINGTALK_MARKERS.d1} 采用原生访问；Doc-D2_旧设计 ${DINGTALK_MARKERS.d2} 采用联邦聚合。`,
      },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkFolder('folder-d')
    )

    const refs = extractExternalKnowledgeRefs(task)
    expect(refs.map(ref => ref.node_id)).toEqual(
      expect.arrayContaining(['folder-d', 'folder-d1', 'doc-d1', 'doc-d2'])
    )
    const evidence = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(evidence.mcpCalls, [INFO_TOOL, INFO_TOOL, CONTENT_TOOL, CONTENT_TOOL])
    expectNoNodeAccess(evidence.mcpCalls, ['doc-d3', 'doc-m1'])
    expect(evidence.mcpCalls.some(call => call.name === SEARCH_TOOL)).toBe(false)
    expect(extractTaskAnswer(task)).toContain(`Doc-D1_新设计 ${DINGTALK_MARKERS.d1}`)
    expect(extractTaskAnswer(task)).toContain(`Doc-D2_旧设计 ${DINGTALK_MARKERS.d2}`)
  })

  test('E2E-A2-007 recursively lists a whole DingTalk knowledge space', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('007', '输出所选知识空间中每份文档的标题和唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(LIST_TOOL, { workspaceId: 'space-d', pageSize: 50 }),
      toolStep(LIST_TOOL, {
        workspaceId: 'space-d',
        pageSize: 50,
        pageToken: 'space-d-page-2',
      }),
      toolStep(LIST_TOOL, { workspaceId: 'space-d', folderId: 'folder-d', pageSize: 50 }),
      toolStep(LIST_TOOL, { workspaceId: 'space-d', folderId: 'folder-d1', pageSize: 50 }),
      {
        toolCalls: ['doc-d1', 'doc-d2', 'doc-d3'].map(nodeId => ({
          toolName: INFO_TOOL,
          arguments: { nodeId },
        })),
      },
      {
        toolCalls: ['doc-d1', 'doc-d2', 'doc-d3'].map(nodeId => ({
          toolName: CONTENT_TOOL,
          arguments: { nodeId },
        })),
      },
      {
        responseContent: `Doc-D1_新设计 ${DINGTALK_MARKERS.d1}\nDoc-D2_旧设计 ${DINGTALK_MARKERS.d2}\nDoc-D3_项目说明 ${DINGTALK_MARKERS.d3}`,
      },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkSpace()
    )

    expect(extractExternalKnowledgeRefs(task)).toEqual([
      expect.objectContaining({
        provider: 'dingtalk',
        id: 'space-d',
        target_type: 'knowledge_base',
      }),
    ])
    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [
      LIST_TOOL,
      LIST_TOOL,
      LIST_TOOL,
      LIST_TOOL,
      INFO_TOOL,
      INFO_TOOL,
      INFO_TOOL,
      CONTENT_TOOL,
      CONTENT_TOOL,
      CONTENT_TOOL,
    ])
    expectNoNodeAccess(mcpCalls, ['doc-m1'])
    const answer = extractTaskAnswer(task)
    expect(answer).toContain(`Doc-D1_新设计 ${DINGTALK_MARKERS.d1}`)
    expect(answer).toContain(`Doc-D2_旧设计 ${DINGTALK_MARKERS.d2}`)
    expect(answer).toContain(`Doc-D3_项目说明 ${DINGTALK_MARKERS.d3}`)
    expect(answer).not.toContain(DINGTALK_MARKERS.m1)
  })

  test('E2E-A2-028 searches within one DingTalk knowledge space with pagination', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('028', '查找包含 ORION 的文档，输出标题和唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(SEARCH_TOOL, { keywords: 'ORION', workspaceIds: ['space-d'], pageSize: 50 }),
      toolStep(SEARCH_TOOL, {
        keywords: 'ORION',
        workspaceIds: ['space-d'],
        pageSize: 50,
        pageToken: 'orion-page-2',
      }),
      toolStep(INFO_TOOL, { nodeId: 'doc-d3' }),
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d3' }),
      { responseContent: `Doc-D3_项目说明 ${DINGTALK_MARKERS.d3}` },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkSpace()
    )

    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [SEARCH_TOOL, SEARCH_TOOL, INFO_TOOL, CONTENT_TOOL])
    expect(mcpCalls[0].arguments).toMatchObject({
      keywords: 'ORION',
      workspaceIds: ['space-d'],
    })
    expect(mcpCalls[1].arguments.pageToken).toBe('orion-page-2')
    expectNoNodeAccess(mcpCalls, ['doc-d1', 'doc-d2', 'doc-m1'])
    expect(extractTaskAnswer(task)).toBe(`Doc-D3_项目说明 ${DINGTALK_MARKERS.d3}`)
  })

  test('E2E-A2-008 keeps Wegent and DingTalk provider parameters isolated', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('008', '比较所选文档，注明来源并输出各自的唯一断言标记。')
    await scenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: 'wegent_kb_read_document_content',
            arguments: { document_id: resources.fixture.documents.a1.id },
          },
          { toolName: INFO_TOOL, arguments: { nodeId: 'doc-d1' } },
        ],
      },
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d1' }),
      { responseContent: `Wegent ${PROVIDER_NATIVE_MARKERS.a1} DingTalk ${DINGTALK_MARKERS.d1}` },
    ])
    const task = await runWithSelection(page, request, prompt, async knowledge => {
      await knowledge.selectDocuments(
        resources.fixture.knowledgeBase.id,
        resources.fixture.knowledgeBase.name,
        [resources.fixture.documents.a1.id]
      )
      await knowledge.selectDingTalkDocuments(['doc-d1'])
    })

    const refs = extractExternalKnowledgeRefs(task)
    expect(refs).toHaveLength(1)
    const toolCalls = collectTaskToolCalls(task)
    expect(
      toolCalls.some(
        call =>
          call.name.endsWith('wegent_kb_read_document_content') &&
          call.input.document_id === resources.fixture.documents.a1.id
      )
    ).toBe(true)
    const evidence = await collectEvidence(request, prompt)
    expect(evidence.modelText).toContain('provider="wegent"')
    expect(evidence.modelText).toContain('provider="dingtalk"')
    expectOnlyProviderCalls(evidence.mcpCalls, [INFO_TOOL, CONTENT_TOOL])
    expect(extractTaskAnswer(task)).toContain(`Wegent ${PROVIDER_NATIVE_MARKERS.a1}`)
    expect(extractTaskAnswer(task)).toContain(`DingTalk ${DINGTALK_MARKERS.d1}`)
  })

  test('E2E-A2-009 groups two Wegent knowledge bases without duplicate Skill loading', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('009', '注明所属知识库并输出各自的唯一断言标记。')
    await scenario(request, prompt, [
      {
        toolCalls: [resources.fixture.documents.a1, resources.fixture.documents.b1].map(
          document => ({
            toolName: 'wegent_kb_read_document_content',
            arguments: { document_id: document.id },
          })
        ),
      },
      {
        responseContent: `${resources.fixture.knowledgeBase.name} ${PROVIDER_NATIVE_MARKERS.a1} ${resources.fixture.otherKnowledgeBase.name} ${PROVIDER_NATIVE_MARKERS.b1}`,
      },
    ])
    const task = await runWithSelection(page, request, prompt, async knowledge => {
      await knowledge.selectDocuments(
        resources.fixture.knowledgeBase.id,
        resources.fixture.knowledgeBase.name,
        [resources.fixture.documents.a1.id]
      )
      await knowledge.selectDocuments(
        resources.fixture.otherKnowledgeBase.id,
        resources.fixture.otherKnowledgeBase.name,
        [resources.fixture.documents.b1.id]
      )
    })

    const bodies = await getScenarioModelBodies(request, prompt)
    const text = modelRequestText(bodies)
    expect(text).toContain(`knowledge_base_id="${resources.fixture.knowledgeBase.id}"`)
    expect(text).toContain(`knowledge_base_id="${resources.fixture.otherKnowledgeBase.id}"`)
    expect((text.match(/# Wegent Knowledge Base Skill/g) || []).length).toBe(bodies.length)
    expect(extractTaskAnswer(task)).toContain(PROVIDER_NATIVE_MARKERS.a1)
    expect(extractTaskAnswer(task)).toContain(PROVIDER_NATIVE_MARKERS.b1)
  })

  test('E2E-A2-011 exposes only provider-native knowledge tools', async ({ page, request }) => {
    const prompt = makePrompt('011', '注明来源并输出所选文档的唯一断言标记。')
    await scenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: 'wegent_kb_read_document_content',
            arguments: { document_id: resources.fixture.documents.a1.id },
          },
          { toolName: INFO_TOOL, arguments: { nodeId: 'doc-d1' } },
        ],
      },
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d1' }),
      {
        responseContent: `Wegent ${PROVIDER_NATIVE_MARKERS.a1} DingTalk ${DINGTALK_MARKERS.d1}`,
      },
    ])
    const task = await runWithSelection(page, request, prompt, async knowledge => {
      await knowledge.selectDocuments(
        resources.fixture.knowledgeBase.id,
        resources.fixture.knowledgeBase.name,
        [resources.fixture.documents.a1.id]
      )
      await knowledge.selectDingTalkDocuments(['doc-d1'])
    })

    const bodies = await getScenarioModelBodies(request, prompt)
    const names = modelToolNames(bodies)
    expect(names.some(name => name.endsWith('wegent_kb_read_document_content'))).toBe(true)
    expect(names.some(name => name.endsWith('get_document_content'))).toBe(true)
    expect(names.some(name => /knowledge_search$|kb_meta_prompt$/.test(name))).toBe(false)
    expect(extractTaskAnswer(task)).toContain(`Wegent ${PROVIDER_NATIVE_MARKERS.a1}`)
    expect(extractTaskAnswer(task)).toContain(`DingTalk ${DINGTALK_MARKERS.d1}`)
  })

  test('E2E-A2-019 deduplicates repeated DingTalk selection and calls', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('019', '输出唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-d1' }),
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d1' }),
      { responseContent: DINGTALK_MARKERS.d1 },
    ])
    const task = await runWithSelection(page, request, prompt, async knowledge => {
      await knowledge.selectDingTalkDocuments(['doc-d1'])
      await knowledge.selectDingTalkDocuments(['doc-d1'])
      await knowledge.selectDingTalkDocuments(['doc-d1'])
    })

    expect(extractExternalKnowledgeRefs(task)).toHaveLength(1)
    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [INFO_TOOL, CONTENT_TOOL])
    expect(count(extractTaskAnswer(task), DINGTALK_MARKERS.d1)).toBe(1)
  })

  test('E2E-A2-020 preserves the DingTalk My Docs identity', async ({ page, request }) => {
    const prompt = makePrompt('020', '输出唯一断言标记和“私有提示”中的测试口令。')
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-m1' }),
      toolStep(CONTENT_TOOL, { nodeId: 'doc-m1' }),
      { responseContent: `${DINGTALK_MARKERS.m1} PERSONAL-CODE-7429` },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkMyDocument('doc-m1')
    )

    expect(extractExternalKnowledgeRefs(task)).toEqual([
      expect.objectContaining({
        provider: 'dingtalk',
        id: 'dingtalk-docs',
        scope: 'docs',
        node_id: 'doc-m1',
      }),
    ])
    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [INFO_TOOL, CONTENT_TOOL])
    expectNoNodeAccess(mcpCalls, ['doc-d1', 'doc-d2', 'doc-d3'])
    expect(extractTaskAnswer(task)).toBe(`${DINGTALK_MARKERS.m1} PERSONAL-CODE-7429`)
  })

  test('E2E-A2-021 preserves provider permission-denied semantics', async ({ page, request }) => {
    await configureMockMcp(request, { deniedNodeIds: ['doc-d1'] })
    const prompt = makePrompt('021', '输出唯一断言标记。')
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-d1' }),
      { responseContent: '无权限读取所选钉钉文档。' },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkDocuments(['doc-d1'])
    )

    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [INFO_TOOL])
    expect(mcpCalls[0].isError).toBe(true)
    expect(JSON.stringify(mcpCalls[0].result)).toContain('permission_denied')
    expect(extractTaskAnswer(task)).toContain('无权限')
    expect(extractTaskAnswer(task)).not.toContain(DINGTALK_MARKERS.d1)
  })

  test('E2E-A2-022 never invokes write tools for a read-only request', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('022', '总结所选文档。')
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-d1' }),
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d1' }),
      { responseContent: `只读摘要 ${DINGTALK_MARKERS.d1}` },
    ])
    await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkDocuments(['doc-d1'])
    )

    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [INFO_TOOL, CONTENT_TOOL])
    expect(mcpCalls.some(call => /create|update|rename|delete/.test(call.name))).toBe(false)
  })

  test('E2E-A2-023 renames only the selected document and keeps content unchanged', async ({
    page,
    request,
  }) => {
    const prompt = makePrompt('023', '将所选文档重命名为“新设计-已评审”，正文保持不变。')
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-d1' }),
      toolStep(RENAME_TOOL, { nodeId: 'doc-d1', name: '新设计-已评审' }),
      toolStep(CONTENT_TOOL, { nodeId: 'doc-d1' }),
      { responseContent: `已重命名为新设计-已评审，正文标记仍为 ${DINGTALK_MARKERS.d1}` },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkDocuments(['doc-d1'])
    )

    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [INFO_TOOL, RENAME_TOOL, CONTENT_TOOL])
    expect(mcpCalls[1].arguments).toEqual({ nodeId: 'doc-d1', name: '新设计-已评审' })
    expect(JSON.stringify(mcpCalls[2].result)).toContain(DINGTALK_MARKERS.d1)
    expectNoNodeAccess(mcpCalls, ['doc-d2', 'doc-d3', 'doc-m1'])
    expect(extractTaskAnswer(task)).toContain('新设计-已评审')
  })

  test('E2E-A2-024 loads DingTalk Docs and AI Table capabilities without mixing IDs', async ({
    page,
    request,
  }) => {
    await configureDingTalkService(request, resources.token, 'ai_table', true)
    const prompt = makePrompt(
      '024',
      '读取所选钉钉文档的唯一断言标记，并读取钉钉 AI 表格 table-beta 的 row-1 值。'
    )
    await scenario(request, prompt, [
      toolStep(INFO_TOOL, { nodeId: 'doc-d1' }),
      {
        toolCalls: [
          { toolName: CONTENT_TOOL, arguments: { nodeId: 'doc-d1' } },
          {
            toolName: 'get_ai_table_records',
            arguments: { tableId: 'table-beta', rowId: 'row-1' },
          },
        ],
      },
      { responseContent: `${DINGTALK_MARKERS.d1} AI-TABLE-ROW-BETA-2026` },
    ])
    const task = await runWithSelection(page, request, prompt, knowledge =>
      knowledge.selectDingTalkDocuments(['doc-d1'])
    )

    const bodies = await getScenarioModelBodies(request, prompt)
    const names = modelToolNames(bodies)
    expect(names.some(name => name.includes('dingtalk_docs') && name.endsWith(CONTENT_TOOL))).toBe(
      true
    )
    expect(
      names.some(
        name => name.includes('dingtalk_ai_table') && name.endsWith('get_ai_table_records')
      )
    ).toBe(true)
    const { mcpCalls } = await collectEvidence(request, prompt)
    expectOnlyProviderCalls(mcpCalls, [INFO_TOOL, CONTENT_TOOL, 'get_ai_table_records'])
    expect(mcpCalls[1].arguments).toEqual({ nodeId: 'doc-d1' })
    expect(mcpCalls[2].arguments).toEqual({ tableId: 'table-beta', rowId: 'row-1' })
    expect(extractTaskAnswer(task)).toBe(`${DINGTALK_MARKERS.d1} AI-TABLE-ROW-BETA-2026`)
    await configureDingTalkService(request, resources.token, 'ai_table', false)
  })

  async function scenario(
    request: APIRequestContext,
    prompt: string,
    steps: Parameters<typeof configureToolScenario>[2]
  ): Promise<void> {
    activePrompt = prompt
    await configureToolScenario(request, prompt, steps)
  }

  async function runWithSelection(
    page: Page,
    request: APIRequestContext,
    prompt: string,
    select: (knowledge: ProviderNativeKnowledgePage) => Promise<void>
  ): Promise<unknown> {
    const knowledge = new ProviderNativeKnowledgePage(page)
    await select(knowledge)
    await knowledge.sendMessage(prompt)
    const taskId = await knowledge.waitForTaskId()
    await waitForTaskTerminal(request, resources.token, taskId)
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30_000 })
    return getTask(request, resources.token, taskId)
  }

  async function collectEvidence(request: APIRequestContext, prompt: string) {
    const bodies = await getScenarioModelBodies(request, prompt)
    expect(bodies.length).toBeGreaterThan(0)
    return {
      modelText: modelRequestText(bodies),
      mcpCalls: await getMcpCalls(request),
    }
  }
})

function toolStep(toolName: string, args: Record<string, unknown>) {
  return { toolCalls: [{ toolName, arguments: args }] }
}

function makePrompt(caseId: string, prompt: string): string {
  return `${TEST_PREFIX} E2E-A2-${caseId} ${prompt}`
}

function expectOnlyProviderCalls(calls: Array<{ name: string }>, expectedNames: string[]): void {
  expect(calls.map(call => call.name)).toEqual(expectedNames)
}

function expectNoNodeAccess(
  calls: Array<{ arguments: Record<string, unknown> }>,
  nodeIds: string[]
): void {
  for (const nodeId of nodeIds) {
    expect(calls.some(call => Object.values(call.arguments).includes(nodeId))).toBe(false)
  }
}

function count(value: string, fragment: string): number {
  return value.split(fragment).length - 1
}
