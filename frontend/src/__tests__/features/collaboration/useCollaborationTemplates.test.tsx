import { renderHook } from '@testing-library/react'
import { useCollaborationTemplates } from '@/features/resource-library/useCollaborationTemplates'

let mockOwnerId: number | undefined = 701
let mockAuthScope = 'template-scope-one'
const mockGet = jest.fn()

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockOwnerId ? { id: mockOwnerId } : null }),
}))
jest.mock('@/lib/runtime-config', () => ({ getApiBaseUrl: () => 'https://templates.test' }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: {
    getCacheScope: () => mockAuthScope,
    get: (...args: unknown[]) => mockGet(...args),
  },
}))

beforeEach(() => {
  mockOwnerId = 701
  mockAuthScope = 'template-scope-one'
  mockGet.mockClear()
  localStorage.clear()
})

test('provides the scoped store in the first authenticated render without loading templates', () => {
  const renders: ReturnType<typeof useCollaborationTemplates>[] = []
  const { result, rerender } = renderHook(() => {
    const store = useCollaborationTemplates()
    renders.push(store)
    return store
  })
  expect(renders[0]?.library.ownerId).toBe(701)
  const store = result.current
  rerender()
  expect(result.current).toBe(store)
  expect(mockGet).not.toHaveBeenCalled()
})

test('switches account scope without publishing a transient empty or previous-owner store', () => {
  mockOwnerId = undefined
  const renders: ReturnType<typeof useCollaborationTemplates>[] = []
  const { result, rerender } = renderHook(() => {
    const store = useCollaborationTemplates()
    renders.push(store)
    return store
  })
  expect(result.current).toBeNull()
  mockOwnerId = 702
  renders.length = 0
  rerender()
  expect(renders[0]?.library.ownerId).toBe(702)
  mockOwnerId = 703
  mockAuthScope = 'template-scope-two'
  renders.length = 0
  rerender()
  expect(renders[0]?.library.ownerId).toBe(703)
  expect(renders.every(store => store?.library.ownerId === 703)).toBe(true)
  expect(mockGet).not.toHaveBeenCalled()
})
