import { describe, expect, test } from 'vitest'
import { findBrowserTabByPopupParent } from './browserPopupRouting'

describe('embedded browser popup routing', () => {
  test('matches a popup by its native parent label when logical labels differ', () => {
    const parentTab = findBrowserTabByPopupParent(
      {
        'browser:1': {
          label: 'workspace-browser-task-1',
          nativeLabel: 'embedded-browser-native-7',
          browserSessionId: '1',
          title: 'Baidu',
          faviconUrl: null,
          hasActiveDownload: false,
          openRequest: null,
        },
      },
      'workspace-browser-stale-label',
      'embedded-browser-native-7'
    )

    expect(parentTab).toBe('browser:1')
  })

  test('does not route a popup from an unknown browser', () => {
    expect(
      findBrowserTabByPopupParent(
        {
          'browser:1': {
            label: 'workspace-browser-task-1',
            nativeLabel: 'embedded-browser-native-7',
            browserSessionId: '1',
            title: null,
            faviconUrl: null,
            hasActiveDownload: false,
            openRequest: null,
          },
        },
        'workspace-browser-other',
        'embedded-browser-native-8'
      )
    ).toBeNull()
  })

  test('does not match an untracked native label when the popup omits it', () => {
    expect(
      findBrowserTabByPopupParent(
        {
          'browser:1': {
            label: 'workspace-browser-task-1',
            browserSessionId: '1',
            title: null,
            faviconUrl: null,
            hasActiveDownload: false,
            openRequest: null,
          },
        },
        'workspace-browser-other'
      )
    ).toBeNull()
  })

  test('prefers the logical label when both parent identifiers are present', () => {
    expect(
      findBrowserTabByPopupParent(
        {
          'browser:1': {
            label: 'workspace-browser-task-1',
            nativeLabel: 'embedded-browser-native-1',
            browserSessionId: '1',
            title: null,
            faviconUrl: null,
            hasActiveDownload: false,
            openRequest: null,
          },
          'browser:2': {
            label: 'workspace-browser-task-2',
            nativeLabel: 'embedded-browser-native-2',
            browserSessionId: '2',
            title: null,
            faviconUrl: null,
            hasActiveDownload: false,
            openRequest: null,
          },
        },
        'workspace-browser-task-1',
        'embedded-browser-native-2'
      )
    ).toBe('browser:1')
  })
})
