import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'

const resolver = createFileTreeIconResolver({ set: 'complete', colored: false })
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
      viewBox={symbol.getAttribute('viewBox')!}
      // Only bundled Pierre icon markup is rendered here, never file contents.
      dangerouslySetInnerHTML={{ __html: symbol.innerHTML }}
    />
  )
}
