import { renderHook, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { useDocumentDetail } from '@/features/knowledge/document/hooks/useDocumentDetail'
import zhKnowledge from '@/i18n/locales/zh-CN/knowledge.json'
import { toast } from 'sonner'

const i18n = createInstance()
void i18n.init({
  lng: 'zh-CN',
  initImmediate: false,
  resources: { 'zh-CN': { knowledge: zhKnowledge } },
})
const mockTranslate = i18n.getFixedT('zh-CN', 'knowledge')

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: { getDocumentDetail: jest.fn() },
}))

jest.mock('sonner', () => ({ toast: { error: jest.fn() } }))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))

beforeEach(() => jest.clearAllMocks())

it('shows a translated content error when preview loading fails', async () => {
  jest.mocked(knowledgeBaseApi.getDocumentDetail).mockRejectedValue(new Error('Unavailable'))

  const { result } = renderHook(() => useDocumentDetail({ kbId: 115, docId: 245 }))

  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(toast.error).toHaveBeenCalledWith('文档内容加载失败，请重试。')
})

it('loads stored preview text without reporting an error', async () => {
  jest.mocked(knowledgeBaseApi.getDocumentDetail).mockResolvedValue({
    document_id: 245,
    content: '索引失败仍然可读。',
    content_length: 9,
    truncated: false,
  })

  const { result } = renderHook(() => useDocumentDetail({ kbId: 115, docId: 245 }))

  await waitFor(() => expect(result.current.fullContent).toBe('索引失败仍然可读。'))
  expect(result.current.error).toBeNull()
  expect(toast.error).not.toHaveBeenCalled()
})
