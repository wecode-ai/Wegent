import { describe, expect, test } from 'vitest'
import { withPublishedPluginCloudLink } from './publishedPluginIdentity'

describe('withPublishedPluginCloudLink', () => {
  test('pending republish clears the previous cloudReleaseId', () => {
    expect(
      withPublishedPluginCloudLink(
        {
          cloudPluginId: 71,
          cloudReleaseId: 82,
          marketplaceName: 'wework-personal',
        },
        71,
        null
      )
    ).toEqual({
      cloudPluginId: 71,
      cloudReleaseId: null,
      marketplaceName: 'wework-personal',
    })
  })
})
