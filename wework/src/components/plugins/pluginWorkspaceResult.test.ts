import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  latestPluginWorkspaceResult,
  parsePluginWorkspaceResults,
  pluginWorkspaceManifestPath,
  stripPluginWorkspaceResultMarkers,
} from './pluginWorkspaceResult'

const marker =
  '[WEGENT_PLUGIN_RESULT]{"schemaVersion":1,"taskId":"42","relativePath":"plugins/cloud-notes","name":"cloud-notes","displayName":"Cloud Notes","description":"Notes","version":"0.1.0","listingType":"skill","logo":"","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"ready"}'

describe('pluginWorkspaceResult', () => {
  test('parses a Task workspace result and hides its transport marker', () => {
    expect(parsePluginWorkspaceResults(marker)).toEqual([
      expect.objectContaining({ taskId: '42', relativePath: 'plugins/cloud-notes' }),
    ])
    expect(stripPluginWorkspaceResultMarkers(`Created successfully.\n${marker}`)).toBe(
      'Created successfully.'
    )
  })

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

  test('builds the manifest path from the restored workspace root', () => {
    const result = parsePluginWorkspaceResults(marker)[0]
    expect(pluginWorkspaceManifestPath('/workspace/42/', result)).toBe(
      '/workspace/42/plugins/cloud-notes/.codex-plugin/plugin.json'
    )
  })
})
