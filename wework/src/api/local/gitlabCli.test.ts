import { expect, test } from 'vitest'
import { gitlabVerificationUrl, isGitlabCliTarget } from './gitlabCli'

test('GitLab device authorization cannot open another instance or credential URL', () => {
  const target = {
    pluginKey: 'gitlab',
    connectorSlug: `wework-gitlab-cli-${'a'.repeat(64)}`,
    instance: 'https://gitlab.example:8443',
  }
  expect(isGitlabCliTarget(target)).toBe(true)
  expect(gitlabVerificationUrl(target, 'https://gitlab.example:8443/oauth/device')).toBe(
    'https://gitlab.example:8443/oauth/device'
  )
  for (const url of [
    'https://gitlab.example/oauth/device',
    'https://evil.example/oauth/device',
    'https://user:secret@gitlab.example:8443/oauth/device',
    'http://gitlab.example:8443/oauth/device',
  ])
    expect(gitlabVerificationUrl(target, url)).toBeNull()
})
