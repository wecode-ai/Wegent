import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseBuildConfig } from './with-build-config.mjs'

describe('optional build-time Backend address', () => {
  it('defaults to empty and preserves explicit environment and command-line choices', () => {
    const command = ['pnpm', 'build:ios', '--output-dir', 'output with spaces']
    expect(parseBuildConfig(['--', ...command], {})).toEqual({
      help: false,
      backendUrl: '',
      command,
    })
    const environment = { EXPO_PUBLIC_BACKEND_URL: 'https://backend.example.com' }
    expect(parseBuildConfig(['--', ...command], environment).backendUrl).toBe(
      environment.EXPO_PUBLIC_BACKEND_URL
    )
    expect(
      parseBuildConfig(
        ['--backend-url', '  https://other.example.com/wegent  ', '--', ...command],
        environment
      ).backendUrl
    ).toBe('https://other.example.com/wegent')
    expect(parseBuildConfig(['--backend-url=', '--', ...command], environment).backendUrl).toBe('')
  })

  it('rejects malformed options and unsafe addresses without disclosing the supplied address', () => {
    for (const address of ['invalid', 'file:///private/build', 'https://user:secret@example.com']) {
      expect(() => parseBuildConfig(['--backend-url', address, '--', 'pnpm', 'build'], {})).toThrow(
        /Backend address/
      )
      try {
        parseBuildConfig(['--backend-url', address, '--', 'pnpm', 'build'], {})
      } catch (error) {
        expect(error.message).not.toContain(address)
      }
    }
    expect(() => parseBuildConfig(['--backend-url'], {})).toThrow(/Invalid build options/)
    expect(() => parseBuildConfig(['--unknown', 'value', '--', 'pnpm'], {})).toThrow(
      /Invalid build options/
    )
    expect(() => parseBuildConfig(['--backend-url', 'https://backend.example.com'], {})).toThrow(
      /build command is required/
    )
  })

  it('passes the address and literal arguments to a real child process and retains its exit status', () => {
    const script = fileURLToPath(new URL('./with-build-config.mjs', import.meta.url))
    const child = `
      console.log(JSON.stringify([process.env.EXPO_PUBLIC_BACKEND_URL, ...process.argv.slice(1)]))
      process.exit(7)
    `
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--backend-url',
        'https://backend.example.com/wegent',
        '--',
        process.execPath,
        '--eval',
        child,
        'argument with spaces',
        'literal-$value',
      ],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(7)
    expect(JSON.parse(result.stdout.trim())).toEqual([
      'https://backend.example.com/wegent',
      'argument with spaces',
      'literal-$value',
    ])
  })
})
