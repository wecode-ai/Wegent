import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'

/** Resolve sources against emitted filenames, rather than bundler callback paths. */
export function verificationSourceMaps(): Plugin {
  return {
    name: 'wework-verification-source-maps',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'asset' || !output.fileName.endsWith('.map')) continue
          const map = JSON.parse(
            typeof output.source === 'string'
              ? output.source
              : Buffer.from(output.source).toString('utf8')
          ) as { sources: string[]; sourceRoot?: string }
          if (!options.dir) throw new Error('Verification source maps require an output directory')
          const directory = dirname(resolve(options.dir, output.fileName))
          map.sources = map.sources.map(source => {
            if (/^[a-z][a-z0-9+.-]+:/i.test(source)) return source
            return pathToFileURL(resolve(directory, map.sourceRoot ?? '', source)).href
          })
          delete map.sourceRoot
          output.source = JSON.stringify(map)
        }
      },
    },
  }
}
