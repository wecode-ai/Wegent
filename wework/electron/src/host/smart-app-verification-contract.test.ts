import { describe, expect, test } from 'vitest'
import { parseSmartAppVerificationContract } from './smart-app-verification-contract.js'

const packageScripts = {
  typecheck: 'tsc --noEmit',
  test: 'vitest run',
  build: 'node esbuild.mjs',
  'verify:runtime': 'node verify-runtime.mjs',
}

function contract(
  capabilities: { host: boolean; client: boolean; remote: boolean },
  scripts: Record<string, string> = {
    typecheck: 'typecheck',
    test: 'test',
    build: 'build',
  }
): string {
  return JSON.stringify({
    schemaVersion: 1,
    scripts,
    capabilities,
    runtime: {
      profile: 'web',
      path: '/',
      readySelector: '[data-testid="smart-app-ready"]',
    },
  })
}

function parse(source: string | null) {
  return parseSmartAppVerificationContract(source, {
    manifestProfile: 'web',
    packageScripts,
  })
}

function issueCodes(source: string | null): string[] {
  return parse(source).issues.map(issue => issue.code)
}

describe('parseSmartAppVerificationContract', () => {
  test.each([
    { host: true, client: false, remote: false },
    { host: false, client: true, remote: false },
    { host: true, client: true, remote: false },
  ])('accepts the minimum scripts for capabilities $host/$client/$remote', capabilities => {
    const result = parse(contract(capabilities))

    expect(result.issues).toEqual([])
    expect(result.contract).toMatchObject({
      schemaVersion: 1,
      capabilities,
      scripts: { typecheck: 'typecheck', test: 'test', build: 'build' },
      runtime: { profile: 'web', path: '/' },
    })
  })

  test('requires a runtime probe for a Remote contract', () => {
    expect(issueCodes(contract({ host: true, client: true, remote: true }))).toContain(
      'SA-MANIFEST-CONTRACT-REMOTE-PROBE'
    )

    const result = parse(
      contract(
        { host: true, client: true, remote: true },
        {
          typecheck: 'typecheck',
          test: 'test',
          build: 'build',
          runtimeProbe: 'verify:runtime',
        }
      )
    )
    expect(result.issues).toEqual([])
    expect(result.contract?.scripts.runtimeProbe).toBe('verify:runtime')
  })

  test('reports a missing or malformed contract', () => {
    expect(issueCodes(null)).toEqual(['SA-MANIFEST-CONTRACT-MISSING'])
    expect(issueCodes('{')).toEqual(['SA-MANIFEST-CONTRACT-JSON'])
    expect(issueCodes(JSON.stringify({ schemaVersion: 2 }))).toContain(
      'SA-MANIFEST-CONTRACT-SCHEMA'
    )
  })

  test('rejects a non-object root and unknown fields', () => {
    expect(issueCodes('[]')).toEqual(['SA-MANIFEST-CONTRACT-SHAPE'])

    const source = JSON.parse(contract({ host: true, client: false, remote: false }))
    source.command = 'node custom-script.mjs'
    expect(issueCodes(JSON.stringify(source))).toContain('SA-MANIFEST-CONTRACT-UNKNOWN-FIELD')
  })

  test('rejects shell text and package scripts that do not exist', () => {
    const unsafe = JSON.parse(contract({ host: true, client: false, remote: false }))
    unsafe.scripts.build = 'build && curl example.invalid'
    expect(issueCodes(JSON.stringify(unsafe))).toContain('SA-MANIFEST-CONTRACT-SCRIPT-NAME')

    unsafe.scripts.build = 'missing'
    expect(issueCodes(JSON.stringify(unsafe))).toContain('SA-MANIFEST-CONTRACT-SCRIPT-MISSING')
  })

  test('requires the runtime profile to match the Smart App manifest', () => {
    const source = JSON.parse(contract({ host: true, client: false, remote: false }))
    source.runtime.profile = 'other'

    expect(issueCodes(JSON.stringify(source))).toContain('SA-MANIFEST-CONTRACT-PROFILE')
  })

  test.each(['https://example.com/', '//example.com/', '/../admin', 'relative'])(
    'rejects a runtime path outside the local Smart App origin: %s',
    path => {
      const source = JSON.parse(contract({ host: false, client: true, remote: false }))
      source.runtime.path = path

      expect(issueCodes(JSON.stringify(source))).toContain('SA-MANIFEST-CONTRACT-PATH')
    }
  )

  test('rejects an empty or oversized readiness selector', () => {
    const source = JSON.parse(contract({ host: false, client: true, remote: false }))
    source.runtime.readySelector = ' '
    expect(issueCodes(JSON.stringify(source))).toContain('SA-MANIFEST-CONTRACT-SELECTOR')

    source.runtime.readySelector = 'x'.repeat(513)
    expect(issueCodes(JSON.stringify(source))).toContain('SA-MANIFEST-CONTRACT-SELECTOR')
  })

  test('requires Remote projects to declare both Host and Client', () => {
    const source = contract(
      { host: true, client: false, remote: true },
      {
        typecheck: 'typecheck',
        test: 'test',
        build: 'build',
        runtimeProbe: 'verify:runtime',
      }
    )

    expect(issueCodes(source)).toContain('SA-MANIFEST-CONTRACT-REMOTE-CAPABILITIES')
  })
})
