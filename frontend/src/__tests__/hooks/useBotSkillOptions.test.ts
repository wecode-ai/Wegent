import { act, renderHook, waitFor } from '@testing-library/react'
import { fetchUnifiedSkillsList, type UnifiedSkill } from '@/apis/skills'
import { useBotSkillOptions } from '@/hooks/useBotSkillOptions'

jest.mock('@/apis/skills', () => ({
  fetchUnifiedSkillsList: jest.fn(),
  fetchPublicSkillsList: jest.fn(),
}))

const fetchSkills = jest.mocked(fetchUnifiedSkillsList)
const skill = { id: 7, name: 'shared-skill' } as UnifiedSkill

beforeEach(() => jest.resetAllMocks())

it('does not load inactive editors or expose results from a previous target', async () => {
  let finishOld!: (skills: UnifiedSkill[]) => void
  fetchSkills.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishOld = resolve
      })
  )
  fetchSkills.mockResolvedValueOnce([skill])
  const { result, rerender } = renderHook(
    ({ namespace, enabled }) => useBotSkillOptions({ namespace }, enabled),
    { initialProps: { namespace: 'all', enabled: false } }
  )
  expect(fetchSkills).not.toHaveBeenCalled()
  rerender({ namespace: 'all', enabled: true })
  rerender({ namespace: 'dev', enabled: true })
  await waitFor(() => expect(result.current.skills).toEqual([skill]))
  await act(async () => {
    finishOld([{ ...skill, id: 99 }])
  })
  expect(result.current.skills).toEqual([skill])
  expect(fetchSkills).toHaveBeenLastCalledWith({ binding: { namespace: 'dev' } })
})

it('exposes a failed request and recovers through an explicit refresh', async () => {
  fetchSkills.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([skill])
  const { result } = renderHook(() => useBotSkillOptions({ namespace: 'dev', botId: 10 }, true))
  await waitFor(() => expect(result.current.error).toBe(true))
  await act(async () => {
    await result.current.reload()
  })
  expect(result.current.error).toBe(false)
  expect(result.current.skills).toEqual([skill])
})
