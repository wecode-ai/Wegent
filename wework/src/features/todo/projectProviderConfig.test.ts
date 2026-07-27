import { describe, expect, it } from 'vitest'
import { repositoryProviderConfig } from './projectProviderConfig'

describe('repositoryProviderConfig', () => {
  it('removes GitLab web page suffixes from repository URLs', () => {
    expect(
      repositoryProviderConfig('https://git.intra.weibo.com/hongyu91/tab-prompt/-/issues', 'gitlab')
    ).toEqual({
      repository: 'hongyu91/tab-prompt',
      domain: 'git.intra.weibo.com',
      api_base: 'https://git.intra.weibo.com/api/v4',
    })
  })
})
