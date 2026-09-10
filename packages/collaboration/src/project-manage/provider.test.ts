// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { repositoryAddress, repositoryProviderConfig } from './provider'

describe('project manage repository provider', () => {
  it('normalizes GitHub shorthand without adding redundant host config', () => {
    expect(repositoryProviderConfig('wecode-ai/Wegent.git', 'github')).toEqual({
      repository: 'wecode-ai/Wegent',
    })
  })

  it('keeps self-hosted GitLab domain and API base', () => {
    expect(
      repositoryProviderConfig('https://git.example.com/team/platform/app.git', 'gitlab')
    ).toEqual({
      repository: 'team/platform/app',
      domain: 'git.example.com',
      api_base: 'https://git.example.com/api/v4',
    })
  })

  it('restores the repository address shown by the existing manage form', () => {
    expect(
      repositoryAddress({
        id: 'project-1',
        task_provider: 'github',
        provider_config: { repository: 'wecode-ai/Wegent' },
        tags: [],
        version: 1,
      })
    ).toBe('https://github.com/wecode-ai/Wegent')
  })
})
