import { apiClient } from '@/apis/client'
import { modelApis, type ModelCRD } from '@/apis/models'

let mockScope = 0
jest.mock('@/apis/client', () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), getCacheScope: () => mockScope },
}))

beforeEach(() => {
  mockScope += 1
  jest.clearAllMocks()
  jest.mocked(apiClient.get).mockResolvedValue({ data: [] })
})

test('deduplicates matching model queries without mixing shell or namespace parameters', async () => {
  await Promise.all([
    modelApis.getUnifiedModels('Codex', false, 'personal', undefined, 'llm'),
    modelApis.getUnifiedModels('Codex', false, 'personal', undefined, 'llm'),
  ])
  await modelApis.getUnifiedModels('Codex', false, 'personal', undefined, 'llm')
  expect(apiClient.get).toHaveBeenCalledTimes(1)
  await modelApis.getUnifiedModels('ClaudeCode', true, 'group', 'engineering', 'llm')
  expect(apiClient.get).toHaveBeenLastCalledWith(
    '/models/unified?shell_type=ClaudeCode&include_config=true&scope=group&group_name=engineering&model_category_type=llm'
  )
  expect(apiClient.get).toHaveBeenCalledTimes(2)
})

test('invalidates unified model reads after a successful model mutation', async () => {
  const query = () => modelApis.getUnifiedModels('Codex', false, 'personal')
  await query()
  jest.mocked(apiClient.post).mockResolvedValue({ metadata: { name: 'new-model' } })
  await modelApis.createModel({ metadata: { name: 'new-model', namespace: 'default' } } as ModelCRD)
  await query()
  expect(apiClient.get).toHaveBeenCalledTimes(2)
})
