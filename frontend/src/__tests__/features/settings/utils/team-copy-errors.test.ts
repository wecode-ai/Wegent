// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { extractDeniedSkillName } from '@/features/settings/utils/teamCopyErrors'

describe('extractDeniedSkillName', () => {
  it('extracts the skill name from the backend copy denial message', () => {
    expect(
      extractDeniedSkillName(
        new Error("Permission denied for skill 'weather-app-100d-analysis-glm'")
      )
    ).toBe('weather-app-100d-analysis-glm')
  })

  it('returns null for unrelated errors', () => {
    expect(extractDeniedSkillName(new Error('Team not found'))).toBeNull()
  })

  it('returns null for non-Error values', () => {
    expect(extractDeniedSkillName(undefined)).toBeNull()
    expect(extractDeniedSkillName('Permission denied for skill')).toBeNull()
  })
})
