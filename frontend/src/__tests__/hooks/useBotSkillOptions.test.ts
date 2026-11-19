import { act, renderHook, waitFor } from '@testing-library/react'
import { fetchUnifiedSkillsList, type SkillBindingTarget, type UnifiedSkill } from '@/apis/skills'
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

it.each(['resolve', 'reject'] as const)(
  'ignores a personal-only request that will %s after the Team groups resolve',
  async completion => {
    let resolveOld!: (skills: UnifiedSkill[]) => void
    let rejectOld!: (error: Error) => void
    fetchSkills.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveOld = resolve
          rejectOld = reject
        })
    )
    fetchSkills.mockResolvedValueOnce([skill])
    const target: SkillBindingTarget = { namespace: 'default', botId: 10 }
    const { result, rerender } = renderHook(
      ({ target }: { target: SkillBindingTarget }) => useBotSkillOptions(target, true),
      { initialProps: { target } }
    )

    rerender({
      target: { namespace: 'default', botId: 10, targetGroupNames: ['engineering', 'research'] },
    })
    await waitFor(() => expect(result.current.skills).toEqual([skill]))
    await act(async () => {
      if (completion === 'resolve') resolveOld([])
      else rejectOld(new Error('Late personal-only failure'))
    })

    expect(result.current.skills).toEqual([skill])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe(false)
    expect(fetchSkills).toHaveBeenLastCalledWith({
      binding: { namespace: 'default', botId: 10, targetGroupNames: ['engineering', 'research'] },
    })
  }
)

it('refreshes with all target groups while keeping the same-scope Skills visible', async () => {
  const target = { namespace: 'default', botId: 10, targetGroupNames: ['engineering', 'research'] }
  fetchSkills.mockResolvedValueOnce([skill])
  const { result } = renderHook(() => useBotSkillOptions(target, true))
  await waitFor(() => expect(result.current.skills).toEqual([skill]))
  let finishRefresh!: (skills: UnifiedSkill[]) => void
  fetchSkills.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishRefresh = resolve
      })
  )

  act(() => {
    void result.current.reload()
  })
  expect(result.current.loading).toBe(true)
  expect(result.current.skills).toEqual([skill])
  expect(fetchSkills).toHaveBeenLastCalledWith({ binding: target })
  const refreshedSkill = { ...skill, id: 8, name: 'new-shared-skill' }
  await act(async () => finishRefresh([skill, refreshedSkill]))

  expect(result.current.skills).toEqual([skill, refreshedSkill])
  expect(result.current.loading).toBe(false)
  expect(result.current.error).toBe(false)
})
