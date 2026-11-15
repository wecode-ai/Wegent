import { registerHooks } from 'node:module'

/**
 * Resolve extensionless TypeScript imports under a set of source directories.
 *
 * Node 22 and 24 can strip these TypeScript sources directly. The resolver keeps
 * scenarios independent of package-local tooling installs such as Vite.
 */
export function registerTypeScriptSourceResolver(sourceDirectories) {
  const sources = sourceDirectories.map(directory => new URL(directory, import.meta.url))
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      for (const source of sources) {
        const packageImport = context.parentURL?.startsWith(source.href)
        const relativeImport = specifier.startsWith('./') || specifier.startsWith('../')
        if (packageImport && relativeImport && !specifier.endsWith('.ts')) {
          return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href)
        }
      }
      return nextResolve(specifier, context)
    },
  })
}
