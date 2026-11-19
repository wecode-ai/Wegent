// @vitest-environment node
import { expect, test } from 'vitest'
import { EFFECT_CORE_FILES, effectViolations } from './check-effect-boundary.mjs'

test('rejects named aliases, namespace/computed access, destructuring and reexports', () => {
  for (const source of [
    "import { useEffect as effect } from 'react'",
    'React.useEffect(() => {}, [])',
    "R['useEffect'](() => {}, [])",
    'const { useEffect: effect } = React',
    "export { useEffect as sync } from 'react'",
  ])
    expect(effectViolations(source, 'packages/collaboration/src/View.tsx')).toHaveLength(1)
})
test('permits only exact core files, not similarly named files or directories', () => {
  const source = "import {useEffect} from 'react'"
  for (const path of EFFECT_CORE_FILES) {
    expect(effectViolations(source, path)).toHaveLength(0)
    expect(effectViolations(source, path.replace(/\.(tsx?)$/, '.extra.$1'))).toHaveLength(1)
  }
  expect(
    effectViolations("// useEffect\nconst text='useEffect'", 'wework/src/View.tsx')
  ).toHaveLength(0)
  expect(
    effectViolations("import {useSyncExternalStore} from 'react'", 'wework/src/View.tsx')
  ).toHaveLength(0)
})
test('inline eslint suppression cannot disable the standalone architecture gate', () => {
  expect(
    effectViolations(
      "/* eslint-disable */\nimport {useEffect} from 'react'",
      'wework/src/View.tsx'
    )[0].line
  ).toBe(2)
})
