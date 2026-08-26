import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { RuntimeTaskCreateRequest } from './api'

const protocolDirectory = resolve(process.cwd(), '../shared/protocol')

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(protocolDirectory, name), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('RuntimeTaskCreateRequest V2 cross-runtime contract', () => {
  test('preserves every producer-facing capability in the golden request', () => {
    const fixtures = loadJson('runtime_task_create_request_v2.golden.json')
    const request = fixtures.fullBackendProject as RuntimeTaskCreateRequest

    expect(request).toMatchObject({
      schemaVersion: 2,
      deviceId: 'cloud-device-1',
      runtimePermissionMode: 'plan',
      modelId: 'moonshot-kimi-k2.7-code-highspeed',
      modelType: 'public',
      initialGoal: {
        objective: 'Complete the implementation and verification',
      },
      initialSupervisor: {
        mode: 'auto',
        intervalSeconds: 60,
      },
    })
    expect(request.additionalSkills).toHaveLength(1)
    expect(request.projectPlugins).toHaveLength(1)
    expect(request.attachments).toHaveLength(1)
    expect(request.additionalContext).toEqual({
      workflowStageInput: {
        kind: 'application',
        value: 'Stage input snapshot',
      },
      externalIssue: {
        kind: 'untrusted',
        value: 'Untrusted external issue text',
      },
    })
    expect(request).not.toHaveProperty('modelConfig')
    expect(request).not.toHaveProperty('workspacePath')
  })

  test('represents a device project without a UI-only project id or path', () => {
    const fixtures = loadJson('runtime_task_create_request_v2.golden.json')
    const request = fixtures.deviceProject as RuntimeTaskCreateRequest

    expect(request).toMatchObject({
      schemaVersion: 2,
      deviceId: 'local-device-1',
      runtimeProjectKey: 'local:wegent',
      runtimeProjectName: 'Wegent',
      runtimeWorkspaceRoots: ['/workspace/Wegent'],
    })
    expect(request).not.toHaveProperty('projectId')
    expect(request).not.toHaveProperty('workspacePath')
  })
})
