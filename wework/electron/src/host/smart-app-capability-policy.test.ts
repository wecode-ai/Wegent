import { describe, expect, test } from 'vitest'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import {
  decideDecisionModelGrant,
  grantedMarketSmartAppIds,
  type SmartAppCapabilitySource,
} from './smart-app-capability-policy.js'

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

const MARKET_ALLOWLIST: NodeJS.ProcessEnv = {
  WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON: '[123, 456]',
}
const LINKED_SWITCH: NodeJS.ProcessEnv = {
  WEWORK_DECISION_PROXY_ALLOW_LINKED_APPS: 'true',
}

describe('Smart app decision capability policy', () => {
  test.each<
    [
      string,
      WorkbenchAppManifest,
      SmartAppCapabilitySource,
      number | null,
      NodeJS.ProcessEnv,
      boolean,
    ]
  >([
    ['missing request', decisionManifest(), 'market', 123, MARKET_ALLOWLIST, false],
    ['declined request', decisionManifest(false), 'market', 123, MARKET_ALLOWLIST, false],
    ['allowlisted market release', decisionManifest(true), 'market', 123, MARKET_ALLOWLIST, true],
    [
      'market id outside the allowlist',
      decisionManifest(true),
      'market',
      999,
      MARKET_ALLOWLIST,
      false,
    ],
    [
      'market release without an id',
      decisionManifest(true),
      'market',
      null,
      MARKET_ALLOWLIST,
      false,
    ],
    ['market release without an allowlist', decisionManifest(true), 'market', 123, {}, false],
    ['linked project denied by default', decisionManifest(true), 'linked', null, {}, false],
    [
      'linked project allowed by the dev switch',
      decisionManifest(true),
      'linked',
      null,
      LINKED_SWITCH,
      true,
    ],
    [
      'managed install is never granted',
      decisionManifest(true),
      'managed',
      null,
      LINKED_SWITCH,
      false,
    ],
  ])('%s', (_label, manifest, source, smartAppId, environment, expected) => {
    expect(decideDecisionModelGrant({ manifest, source, smartAppId, environment })).toBe(expected)
  })

  test('ignores a malformed market allowlist instead of granting', () => {
    expect(grantedMarketSmartAppIds({})).toEqual(new Set())
    expect(
      grantedMarketSmartAppIds({ WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON: '' })
    ).toEqual(new Set())
    expect(
      grantedMarketSmartAppIds({ WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON: '[123,' })
    ).toEqual(new Set())
    expect(
      grantedMarketSmartAppIds({ WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON: '{"id":123}' })
    ).toEqual(new Set())
    expect(
      grantedMarketSmartAppIds({
        WEWORK_DECISION_PROXY_GRANTED_SMART_APP_IDS_JSON: '["123", 456, 0, -7]',
      })
    ).toEqual(new Set([456]))
  })

  test('requires an explicit true for the linked development switch', () => {
    const grant = (value: string) =>
      decideDecisionModelGrant({
        manifest: decisionManifest(true),
        source: 'linked',
        smartAppId: null,
        environment: { WEWORK_DECISION_PROXY_ALLOW_LINKED_APPS: value },
      })

    expect(grant('1')).toBe(false)
    expect(grant('yes')).toBe(false)
    expect(grant('FALSE')).toBe(false)
    expect(grant('TRUE')).toBe(true)
    expect(grant(' true ')).toBe(true)
  })
})
