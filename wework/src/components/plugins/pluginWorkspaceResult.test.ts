// @vitest-environment node

import type { WorkbenchMessage } from '@/types/workbench'
import { describe, expect, test } from 'vitest'
import { latestPluginWorkspaceResult, parsePluginWorkspaceResults } from './pluginWorkspaceResult'

const marker =
  '[WEGENT_PLUGIN_RESULT]{"schemaVersion":1,"taskId":"42","relativePath":"plugins/cloud-notes","name":"cloud-notes","displayName":"Cloud Notes","description":"Notes","version":"0.1.0","listingType":"skill","logo":"","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"ready"}'

describe('pluginWorkspaceResult', () => {
  test('selects only the latest result from the active Task', () => {
    const messages = [
      { id: '1', role: 'assistant', status: 'sent', content: marker },
      {
        id: '2',
        role: 'assistant',
        status: 'sent',
        content: marker.replace('"taskId":"42"', '"taskId":"43"'),
      },
    ] as WorkbenchMessage[]

    expect(latestPluginWorkspaceResult(messages, '42')?.taskId).toBe('42')
    expect(latestPluginWorkspaceResult(messages, '43')?.taskId).toBe('43')
  })

  test('rejects paths that escape the Task workspace', () => {
    expect(parsePluginWorkspaceResults(marker.replace('plugins/cloud-notes', '../secret'))).toEqual(
      []
    )
  })
})
