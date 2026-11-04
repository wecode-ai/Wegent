// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { encodeRightWorkspaceExtensionTabId } from './rightWorkspaceDshSidebar'

describe('rightWorkspaceDshSidebar', () => {
  test('uses an isolated internal id while preserving the plugin tab id', () => {
    expect(encodeRightWorkspaceExtensionTabId('native-plugin:panel')).toBe(
      'dsh:native-plugin%3Apanel'
    )
  })
})
