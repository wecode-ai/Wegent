import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { attachDshUiEntryStylesheets } from './dshUiEntryStylesheets'

it('exports actual built static dependency CSS for directly imported DSH entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wework-dsh-styles-'))
  try {
    await writeFile(
      path.join(root, 'entry.js'),
      'import value from "./shared.js"; export default value'
    )
    await writeFile(
      path.join(root, 'main.js'),
      'import value from "./shared.js"; console.log(value)'
    )
    await writeFile(
      path.join(root, 'shared.js'),
      'import styles from "./composer.module.css"; export default styles.inputViewport'
    )
    await writeFile(
      path.join(root, 'composer.module.css'),
      '.inputViewport { max-height: 25dvh; overflow-y: auto }'
    )
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'dsh-entry-styles',
          generateBundle(_options, bundle) {
            attachDshUiEntryStylesheets(bundle)
          },
        },
      ],
      build: {
        minify: false,
        rolldownOptions: {
          preserveEntrySignatures: 'strict',
          input: {
            'wework-ui-fixture': path.join(root, 'entry.js'),
            main: path.join(root, 'main.js'),
          },
          output: { entryFileNames: 'plugins/[name].js' },
        },
      },
    })
    const entry = await readFile(path.join(root, 'dist/plugins/wework-ui-fixture.js'), 'utf8')
    expect(entry).toContain('export const __weworkStylesheets')
    const stylesheet = entry.match(/new URL\("([^"\n]+\.css)"/)?.[1]
    expect(stylesheet).toBeDefined()
    const css = await readFile(path.resolve(root, 'dist/plugins', stylesheet!), 'utf8')
    expect(css).toContain('max-height: 25dvh')
    expect(css).toContain('overflow-y: auto')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
