import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'

const resolver = createFileTreeIconResolver({ set: 'complete' })
// Match Pierre's built-in file-type palette outside the tree's shadow root.
const iconColors = Object.fromEntries(
  [
    ['light-dark(#84848a, #adadb1)', 'default text'],
    ['light-dark(#d52c36, #ff6762)', 'npm postcss ruby svelte yml'],
    ['light-dark(#ff8c5b, #d5512f)', 'git'],
    ['light-dark(#d47628, #ffa359)', 'claude html json rust svg swift zig zip'],
    ['light-dark(#d5a910, #ffd452)', 'babel browserslist javascript'],
    ['light-dark(#199f43, #5ecc71)', 'bash markdown svgo vue'],
    ['light-dark(#17a5af, #64d1db)', 'mcp prettier table'],
    ['light-dark(#1ca1c7, #68cdf2)', 'go oxc react tailwind'],
    ['light-dark(#1a85d4, #69b1ff)', 'biome c cpp docker python typescript vscode webpack'],
    ['light-dark(#693acf, #9d6afb)', 'bootstrap css eslint terraform wasm'],
    ['light-dark(#a631be, #d568ea)', 'astro database vite'],
    ['light-dark(#d32a61, #ff678d)', 'graphql image sass'],
    ['light-dark(#594c5b, #79697b)', 'bun'],
  ].flatMap(([color, tokens]) => tokens.split(' ').map(token => [token, color]))
)
let sprite: Document | undefined

export function WorkspaceFileIcon({ path, testId }: { path: string; testId: string }) {
  const icon = resolver.resolveIcon('file-tree-icon-file', path.replace(/\\/g, '/'))
  sprite ??= new DOMParser().parseFromString(getBuiltInSpriteSheet('complete'), 'text/html')
  const symbol = sprite.getElementById(icon.name)!

  return (
    <svg
      data-testid={testId}
      data-file-icon={icon.token}
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      style={icon.token ? { color: iconColors[icon.token] } : undefined}
      viewBox={symbol.getAttribute('viewBox')!}
      // Only bundled Pierre icon markup is rendered here, never file contents.
      dangerouslySetInnerHTML={{ __html: symbol.innerHTML }}
    />
  )
}
