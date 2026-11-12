import { taskApis } from '@/apis/tasks'
import taskMemberApi from '@/apis/task-member'

const mockGetToken = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/apis/user', () => ({ getToken: () => mockGetToken() }))
jest.mock('@/apis/client', () => ({ __esModule: true, apiClient: {}, default: {} }))

describe('shared task session transport', () => {
  beforeEach(() => {
    mockGetToken.mockReset()
    mockFetch.mockReset()
    global.fetch = mockFetch
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ subtasks: [] }) })
  })

  it('sends an existing session and preserves quoted legacy URL characters', async () => {
    mockGetToken.mockReturnValue('session')
    await taskApis.getPublicSharedTask('old%2B%3D')
    const [url, options] = mockFetch.mock.calls[0]
    expect(new URL(url, 'http://localhost').searchParams.get('token')).toBe('old%2B%3D')
    expect(options.headers.Authorization).toBe('Bearer session')
  })

  it('keeps opaque shares anonymous when no session exists', async () => {
    mockGetToken.mockReturnValue(null)
    await taskApis.getPublicSharedTask('opaque')
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })

  it('sends existing task permission credentials when reading a legacy invite', async () => {
    mockGetToken.mockReturnValue('session')
    await taskMemberApi.getInviteInfo('invite%2B%3D')
    const [url, options] = mockFetch.mock.calls[0]
    expect(new URL(url, 'http://localhost').searchParams.get('token')).toBe('invite%2B%3D')
    expect(options.headers.Authorization).toBe('Bearer session')
  })

  it.each([401, 403])('preserves %s for the share page access explanation', async status => {
    mockFetch.mockResolvedValue({
      ok: false,
      status,
      text: async () => JSON.stringify({ detail: 'Legacy share link requires resource access' }),
    })
    await expect(taskApis.getPublicSharedTask('legacy')).rejects.toMatchObject({ status })
  })
})
