import { resolveTeamInputPlaceholder } from '@/features/tasks/components/input/ChatInput'
import type { Team } from '@/types/api'

function makeTeam(inputPlaceholder: Team['inputPlaceholder']): Team {
  return {
    id: 1,
    name: 'video-agent',
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '',
    updated_at: '',
    inputPlaceholder,
  }
}

describe('resolveTeamInputPlaceholder', () => {
  test('prefers the desktop placeholder for the current language', () => {
    const team = makeTeam({
      zh: '通用提示',
      desktop: { zh: '桌面提示', en: 'Desktop prompt' },
    })

    expect(resolveTeamInputPlaceholder(team, 'zh', false)).toBe('桌面提示')
  })

  test('prefers the mobile placeholder on mobile', () => {
    const team = makeTeam({
      zh: '通用提示',
      mobile: { zh: '移动提示', en: 'Mobile prompt' },
    })

    expect(resolveTeamInputPlaceholder(team, 'zh', true)).toBe('移动提示')
  })

  test('falls back to the generic placeholder and ignores blank values', () => {
    const team = makeTeam({
      en: 'Generic prompt',
      desktop: { en: '   ' },
    })

    expect(resolveTeamInputPlaceholder(team, 'en', false)).toBe('Generic prompt')
  })

  test('returns null when the team has no configured placeholder', () => {
    expect(resolveTeamInputPlaceholder(makeTeam(undefined), 'en', false)).toBeNull()
  })
})
