import { describe, expect, test } from 'vitest'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { decideDecisionModelGrant } from './smart-app-capability-policy.js'

function decisionManifest(decisionModel?: boolean): WorkbenchAppManifest {
  return {
    name: 'dsh-batch-decision',
    displayName: 'Batch Decision',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Decision workbench fixture',
    entry: { installPackage: 'app', profile: 'dsh-batch-decision' },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
    ...(decisionModel === undefined ? {} : { capabilities: { decisionModel } }),
  }
}

describe('Smart app decision capability policy', () => {
  test('grants the built-in router to every app that declares the capability', () => {
    expect(decideDecisionModelGrant(decisionManifest(true))).toBe(true)
  })

  test('withholds the router from an app that does not request it', () => {
    expect(decideDecisionModelGrant(decisionManifest())).toBe(false)
    expect(decideDecisionModelGrant(decisionManifest(false))).toBe(false)
  })
})
