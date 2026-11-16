import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import { expect, test } from 'vitest'

const recipes = {
  'assistant/TeamRelay.css': [
    'assistant-enter',
    'assistant-signal-breathe',
    'assistant-waiting-pulse',
    'assistant-presence-enter',
  ],
  'assistant/AssistantExperience.css': [
    'assistant-enter',
    'assistant-live-trace',
    'assistant-signal-breathe',
    'assistant-enter',
    'assistant-active-rail',
    'assistant-card-enter',
    'assistant-row-enter',
  ],
  'tasks/TasksExperience.css': [
    'experience-task-enter',
    'experience-task-live-trace',
    'experience-task-enter',
  ],
}

for (const [file, names] of Object.entries(recipes)) {
  const root = postcss.parse(fs.readFileSync(path.join(import.meta.dirname, file), 'utf8'))

  test(`${file} enables decorative animation only when native motion preference allows it`, () => {
    const ungated: string[] = []
    root.walkDecls(/^(?:animation|transition)(?:-|$)/, declaration => {
      if (declaration.value === 'none') return
      let parent = declaration.parent
      while (
        parent &&
        !(
          parent.type === 'atrule' &&
          parent.name === 'media' &&
          parent.params === '(prefers-reduced-motion: no-preference)'
        )
      )
        parent = parent.parent
      if (!parent)
        ungated.push(
          `${declaration.parent?.type === 'rule' ? declaration.parent.selector : ''}: ${declaration.prop}: ${declaration.value}`
        )
      expect(declaration.important).toBeFalsy()
    })
    // No animation declaration can participate in a reduced-motion cascade,
    // including higher-specificity live states and pseudo-elements.
    expect(ungated).toEqual([])
  })

  test(`${file} retains every original animation for no-preference`, () => {
    const animations: string[] = []
    root.walkDecls('animation', declaration => {
      if (declaration.value === 'none') return
      const name = declaration.value.match(/(?:assistant|experience-task)-[a-z-]+/)?.[0]
      expect(name, declaration.value).toBeDefined()
      animations.push(name!)
    })
    expect(animations).toEqual(names)
  })
}
