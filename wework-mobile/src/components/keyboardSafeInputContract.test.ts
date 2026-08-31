import { describe, expect, it } from 'vitest'

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { eager: true; import: 'default'; query: '?raw' }
    ): Record<string, string>
  }
}

const sourceModules = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>
const directTextInputImport =
  /import\s+(?:type\s+)?\{[^}]*\bTextInput\b[^}]*\}\s+from\s+['"]react-native(?:-paper)?['"]/s

describe('keyboard-safe input contract', () => {
  it('keeps every business input behind the shared keyboard-safe components', () => {
    const offenders = Object.entries(sourceModules)
      .filter(([file]) => !file.endsWith('/KeyboardSafeInput.tsx'))
      .filter(([, source]) => directTextInputImport.test(source))
      .map(([file]) => file)

    expect(offenders).toEqual([])
  })
})
