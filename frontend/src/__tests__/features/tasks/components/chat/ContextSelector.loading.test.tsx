import { render, waitFor } from '@testing-library/react'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'

jest.mock('@/apis/knowledge-base', () => ({ knowledgeBaseApi: { getAllGrouped: jest.fn() } }))
jest.mock('@/apis/task-knowledge-base', () => ({
  taskKnowledgeBaseApi: { getBoundKnowledgeBases: jest.fn() },
}))
jest.mock('@/hooks/useTranslation', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})
jest.mock('@/features/layout/hooks/useMediaQuery', () => ({ useIsMobile: () => false }))
jest.mock('@/features/knowledge/externalKnowledgeSourceRegistry', () => ({
  useExternalKnowledgeSources: () => [],
}))
jest.mock('@/features/tasks/components/chat/KnowledgeSourcePicker', () => ({
  KnowledgeSourcePicker: () => null,
}))

it('loads catalogs only on open, and refreshes them when reopened', async () => {
  jest.mocked(knowledgeBaseApi.getAllGrouped).mockResolvedValue({
    personal: { created_by_me: [], shared_with_me: [] },
    groups: [],
    organization: { namespace: null, display_name: null, kb_count: 0, knowledge_bases: [] },
    summary: { total_count: 0, personal_count: 0, group_count: 0, organization_count: 0 },
  })
  jest
    .mocked(taskKnowledgeBaseApi.getBoundKnowledgeBases)
    .mockResolvedValue({ items: [], total: 0, max_limit: 10 })
  const props = {
    onOpenChange: jest.fn(),
    selectedContexts: [],
    onSelect: jest.fn(),
    onDeselect: jest.fn(),
    onReplaceContexts: jest.fn(),
    taskId: 10,
    isGroupChat: true,
    children: <button>Knowledge</button>,
  }
  const { rerender } = render(<ContextSelector {...props} open={false} />)
  expect(knowledgeBaseApi.getAllGrouped).not.toHaveBeenCalled()
  expect(taskKnowledgeBaseApi.getBoundKnowledgeBases).not.toHaveBeenCalled()
  rerender(<ContextSelector {...props} open />)
  await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(1))
  expect(taskKnowledgeBaseApi.getBoundKnowledgeBases).toHaveBeenCalledWith(10)
  rerender(<ContextSelector {...props} open={false} />)
  rerender(<ContextSelector {...props} open taskId={11} />)
  await waitFor(() => expect(knowledgeBaseApi.getAllGrouped).toHaveBeenCalledTimes(2))
  expect(taskKnowledgeBaseApi.getBoundKnowledgeBases).toHaveBeenLastCalledWith(11)
})
