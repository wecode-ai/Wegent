import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  APPLICATION_MENU_ACTIONS,
  APPLICATION_MENU_CAPABILITIES,
} from '../../src/desktop/applicationMenuModel'

/**
 * The Electron host declares its own copy of the menu actions and
 * capabilities because the host and renderer are separate TypeScript
 * projects. This test fails when the two declarations drift, so a new menu
 * item cannot be added on one side only.
 *
 * The host module cannot be imported at runtime here — it is a different
 * TypeScript project and pulls in Electron types — so its table is parsed from
 * source. Parsing fails loudly rather than returning an empty map, because a
 * silent empty result would make the contract test pass vacuously.
 */
function parseStringMap(source: string, exportName: string): Record<string, string> {
  const start = source.indexOf(`export const ${exportName}`)
  if (start < 0) throw new Error(`${exportName} is missing from the host menu source`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`${exportName} has no object literal body`)
  const body = source.slice(open + 1, close)
  const entries: Record<string, string> = {}
  for (const match of body.matchAll(/(\w+):\s*'([^']+)'/g)) {
    entries[match[1]] = match[2]
  }
  if (Object.keys(entries).length === 0) {
    throw new Error(`${exportName} could not be parsed; its source format changed`)
  }
  return entries
}

describe('application menu host/renderer contract', () => {
  const hostSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../electron/src/host/application-menu.ts'),
    'utf8'
  )

  test('host and renderer declare the same actions', () => {
    expect(parseStringMap(hostSource, 'APPLICATION_MENU_ACTIONS')).toEqual(APPLICATION_MENU_ACTIONS)
  })

  test('host and renderer declare the same capabilities', () => {
    expect(parseStringMap(hostSource, 'APPLICATION_MENU_CAPABILITIES')).toEqual(
      APPLICATION_MENU_CAPABILITIES
    )
  })
})
