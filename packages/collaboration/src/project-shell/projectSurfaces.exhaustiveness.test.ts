import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('rejects a registered view without a mapping at the never branch', () => {
  const path = fileURLToPath(new URL('./projectSurfaces.ts', import.meta.url))
  const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url))
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const { options, fileNames } = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    fileURLToPath(new URL('../../', import.meta.url))
  )
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile.bind(host)
  const source = readFile(path)!
  const typesPath = fileURLToPath(new URL('../types.ts', import.meta.url))
  const typesSource = ts.createSourceFile(typesPath, readFile(typesPath)!, ts.ScriptTarget.ES2022)
  const viewDeclaration = typesSource.statements.find(
    statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'CollaborationView'
  )
  expect(viewDeclaration).toBeDefined()
  const marker = 'export const projectViewRegistry = Object.freeze({'
  expect(source).toContain(marker)
  // Compile the real view union without pulling unrelated UI and API types into this mutation test.
  host.readFile = file => {
    if (file === path) return source.replace(marker, `${marker}\n  futureView: 'extension',`)
    if (file === typesPath) return viewDeclaration!.getText(typesSource)
    return readFile(file)
  }

  const program = ts.createProgram(
    [path, ...fileNames.filter(file => file.endsWith('.d.ts'))],
    { ...options, types: [] },
    host
  )
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter(error => error.category === ts.DiagnosticCategory.Error)
  expect(
    errors,
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
      getCanonicalFileName: file => file,
      getNewLine: () => '\n',
    })
  ).toHaveLength(1)
  const [error] = errors
  expect(error.file?.fileName).toBe(path)
  expect(error.code).toBe(2345)
  expect(ts.flattenDiagnosticMessageText(error.messageText, '\n')).toContain('never')
  const errorSource = error.file!.text
  const lineStart = errorSource.lastIndexOf('\n', error.start!) + 1
  const lineEnd = errorSource.indexOf('\n', error.start!)
  expect(errorSource.slice(lineStart, lineEnd)).toContain('assertNever(view)')
})
