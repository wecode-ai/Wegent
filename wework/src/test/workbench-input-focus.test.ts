import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss, { type Root } from 'postcss'
import tailwindcss from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig'
import { afterAll, beforeAll, expect, test } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const sources = {
  members: readSource('../packages/collaboration/src/project-manage/ProjectMembersSection.tsx'),
  agents: readSource('../packages/collaboration/src/project-agent-config/ProjectAgentPicker.tsx'),
  composer: readSource('../packages/collaboration/src/composer/ProjectChatComposerSurface.tsx'),
  projects: readSource('src/components/chat/composer/PopoutWorkspaceMenu.tsx'),
  branches: readSource('dsh/ui-git/src/workspace-menu-section.tsx'),
  errors: readSource('src/components/plugins/workspace/AddMarketDialog.tsx'),
  browser: readSource('src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx'),
  standInProject: readSource('src/features/todo/StandInProjectSetup.tsx'),
  projectSpace: readSource('src/features/todo/ProjectSpacePickerMenu.tsx'),
}
const variants = `
  border border-[#737373]/[.37] keyboard:focus:border-[#339cff]/70
  border-transparent border-0 keyboard:focus-visible:ring-2
  keyboard:focus-visible:ring-focus/70 keyboard:focus-visible:ring-offset-2
  keyboard:focus:ring-2 keyboard:focus:ring-focus/20 shadow-sm ring-2 ring-focus/20
  focus:ring-2 focus:ring-red-500/15 focus:border-red-500
  focus:ring-border/60 group group-focus-within:opacity-100 opacity-0
  focus-visible:outline-2 focus-visible:outline-red-500 bg-[#ffffff] focus:bg-[#eeeeee]
`
let css = ''
type Modality = 'pointer' | 'keyboard' | undefined
const frames = new Map<string, HTMLIFrameElement>()

function sourceClass(source: string, expression: RegExp) {
  const match = source.match(expression)
  expect(match, expression.source).not.toBeNull()
  return match![1].replace(/\$\{[^}]+\}/g, '').trim()
}

function field(classes: string, tag = 'input') {
  return `<${tag} data-target data-focus class="${classes}"></${tag}>`
}

function container(classes: string, child = '<button data-focus>Choose</button>') {
  return `<div data-target class="${classes}">${child}</div>`
}

function normalizeFixtureColors(root: Root) {
  // jsdom's stylesheet cascade ignores space-separated rgb() and opacity variables.
  // Preserve selectors and color values; browsers consume the original CSS.
  root.walkDecls(/^(border|background|outline)-color$/, declaration => {
    declaration.value = declaration.value.replace(
      /rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d*\.?\d+|var\(--tw-(?:border|bg)-opacity(?:,\s*\d*\.?\d+)?\))\)/g,
      (match: string, red: string, green: string, blue: string, alpha: string) => {
        const variable = alpha.match(/^var\((--tw-(?:border|bg)-opacity)(?:,\s*\d*\.?\d+)?\)$/)
        if (variable) {
          const opacity = declaration.parent?.nodes.find(
            node => node.type === 'decl' && node.prop === variable[1]
          )
          if (opacity?.type !== 'decl') return match
          alpha = opacity.value
        }
        return /^\d*\.?\d+$/.test(alpha) ? `rgba(${red}, ${green}, ${blue}, ${alpha})` : match
      }
    )
  })
}

function fixtureFrame(modality: Modality, theme: string) {
  const key = JSON.stringify([modality, theme])
  const existing = frames.get(key)
  if (existing) return existing

  // Keep root attributes fixed to avoid jsdom's stale modality selector cache.
  // Parse the full stylesheet once per mode, with fresh controls for every probe.
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const copy = frame.contentDocument!
  if (modality) copy.documentElement.dataset.inputModality = modality
  copy.documentElement.classList.toggle('dark', theme === 'dark')
  const style = copy.createElement('style')
  style.textContent = css
  copy.head.append(style)
  frames.set(key, frame)
  return frame
}

function computed(markup: string, modality: Modality, { focus = true, theme = 'light' } = {}) {
  // This checks cascade results; jsdom does not composite variable-based shadows.
  // Real pointer/Tab events and the rendered ring layers need browser verification.
  const frame = fixtureFrame(modality, theme)
  const copy = frame.contentDocument!
  const view = frame.contentWindow as Window & typeof globalThis
  try {
    copy.body.innerHTML = markup
    const target = copy.querySelector<HTMLElement>('[data-target]')!
    const control = copy.querySelector<HTMLElement>('[data-focus]')!
    if (focus) {
      // Exercise suppression even when native focus-visible matches the control.
      copy.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Tab' }))
      control.focus()
      expect(copy.activeElement).toBe(control)
      expect(control.matches(':focus-visible')).toBe(true)
    }
    const result = view.getComputedStyle(target)
    const property = (name: string) => result.getPropertyValue(name).trim()
    return {
      border: result.borderColor,
      borderWidth: result.borderTopWidth,
      background: result.backgroundColor,
      opacity: result.opacity,
      outlineColor: result.outlineColor,
      outlineWidth: result.outlineWidth,
      shadow: result.boxShadow,
      ring: property('--tw-ring-shadow'),
      ringColor: property('--tw-ring-color'),
      offset: property('--tw-ring-offset-shadow'),
      offsetWidth: property('--tw-ring-offset-width'),
      ordinaryShadow: property('--tw-shadow'),
      dshColor: property('--dsw-focus-ring-color'),
      radius: result.borderRadius,
    }
  } finally {
    copy.body.replaceChildren()
  }
}

function expectPointerBaseline(markup: string, theme = 'light') {
  const baseline = computed(markup, 'pointer', { focus: false, theme })
  const pointer = computed(markup, 'pointer', { theme })
  expect(pointer.border).toBe(baseline.border)
  expect(pointer.borderWidth).toBe(baseline.borderWidth)
  expect(pointer.ring).toBe(baseline.ring)
  expect(pointer.offset).toBe(baseline.offset)
  expect(pointer.offsetWidth).toBe(baseline.offsetWidth)
  expect(pointer.shadow).toBe(baseline.shadow)
  expect(pointer.ordinaryShadow).toBe(baseline.ordinaryShadow)
  return { baseline, pointer }
}

beforeAll(async () => {
  const config = loadConfig(resolve(process.cwd(), 'tailwind.config.js'))
  const result = await postcss([
    tailwindcss({
      ...config,
      content: [...Object.values(sources), variants].map(raw => ({ raw, extension: 'tsx' })),
    }),
  ]).process(readSource('src/styles/globals.css'), { from: undefined })
  const shared = [
    '../packages/collaboration/src/platform/base.css',
    '../packages/collaboration/src/platform/platform.css',
    '../packages/collaboration/src/issue-detail/task-detail-layout.css',
  ].map(readSource)
  const compiled = postcss.parse(shared.join('\n') + result.css)
  // jsdom rejects empty Tailwind defaults; real-browser checks use unmodified CSS.
  compiled.walkDecls(/^--tw-/, declaration => {
    if (!declaration.value.trim()) declaration.remove()
  })
  normalizeFixtureColors(compiled)
  // jsdom ignores the entire selector list when a universal rule includes pseudos.
  // Pseudo-element defaults do not affect these element-only fixture assertions.
  compiled.walkRules(rule => {
    const elements = rule.selectors.filter(selector => !/^::(?:before|after)$/.test(selector))
    if (elements.length) rule.selectors = elements
  })
  css = `
    :root {
      --color-border: 100 110 120;
      --color-focus: 51 156 255;
      --color-primary: 51 156 255;
      --color-bg-base: 255 255 255;
      --color-bg-surface: 245 245 245;
      --color-bg-muted: 238 238 238;
      --dsw-alias-state-business-primary: rgb(51, 156, 255);
    }
    .dark { --color-border: 90 95 100; --color-bg-base: 20 20 20; }
    .focus-token-baseline { --dsw-focus-ring-color: rgb(51, 156, 255); }
    /* The DSH runtime's focus CSS, including its existing non-editable rule. */
    :root { --dsw-focus-ring-width: 2px; }
    :focus-visible {
      outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
      outline-width: var(--dsw-focus-ring-width);
    }
    html[data-input-modality=pointer] body :focus-visible:not(:read-write) {
      --dsw-focus-ring-color: transparent;
      outline-color: #0000;
    }
    ${compiled.toString()}
  `
  for (const theme of ['light', 'dark']) {
    for (const modality of ['pointer', 'keyboard', undefined] as const) {
      fixtureFrame(modality, theme)
    }
  }
})

afterAll(() => {
  for (const frame of frames.values()) frame.remove()
  frames.clear()
})

test.each(['light', 'dark'])(
  '%s theme keeps an arbitrary border opacity without a pointer restoration rule',
  theme => {
    const markup = field('border border-[#737373]/[.37] keyboard:focus:border-[#339cff]/70')
    const { baseline, pointer } = expectPointerBaseline(markup, theme)
    expect(baseline.border).not.toBe('')
    expect(baseline.border).toBe('rgba(115, 115, 115, 0.37)')
    for (const modality of ['keyboard', undefined] as const) {
      const keyboard = computed(markup, modality, { theme })
      expect(keyboard.border).not.toBe(pointer.border)
      expect(keyboard.border).toBe('rgba(51, 156, 255, 0.7)')
      expect(keyboard.borderWidth).toBe(baseline.borderWidth)
    }
  }
)

test.each(['border-transparent border', 'border-0'])(
  '%s stays unchanged on pointer focus without gaining a gray border',
  classes => {
    const markup = field(
      `${classes} keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70`
    )
    const { pointer } = expectPointerBaseline(markup)
    for (const modality of ['keyboard', undefined] as const) {
      expect(computed(markup, modality).ring).not.toBe(pointer.ring)
    }
  }
)

test.each(['light', 'dark'])(
  '%s member controls keep ordinary shadows and have no pointer ring or offset',
  theme => {
    const classes = sourceClass(sources.members, /const focus =\s*'([^']+)'/)
    const markup = field(`border border-transparent shadow-sm ${classes}`, 'select')
    const { baseline, pointer } = expectPointerBaseline(markup, theme)
    expect(baseline.ordinaryShadow).not.toBe('')
    expect(baseline.ordinaryShadow).not.toBe('0 0 #0000')
    expect(pointer.offsetWidth).toBe('0px')
    for (const modality of ['keyboard', undefined] as const) {
      const keyboard = computed(markup, modality, { theme })
      expect(keyboard.offsetWidth).toBe('2px')
      expect(keyboard.ring).not.toBe(pointer.ring)
      expect(keyboard.ordinaryShadow).toBe(baseline.ordinaryShadow)
    }
  }
)

test('non-text radio rows gate their complete focus-within ring', () => {
  const classes = sourceClass(
    sources.agents,
    /className={`([^`]*focus-within:ring-focus\/20[^`]*)`}/
  )
  const markup = container(classes, '<input data-focus type="radio">')
  const { pointer } = expectPointerBaseline(markup)
  for (const modality of ['keyboard', undefined] as const) {
    expect(computed(markup, modality).ring).not.toBe(pointer.ring)
  }
})

test.each([
  {
    name: 'project stand-in selection',
    source: sources.standInProject,
    expression: /className="([^"]*focus-within:ring-focus[^"]*)"/,
    tag: 'select',
    nested: true,
  },
  {
    name: 'project space search',
    source: sources.projectSpace,
    expression: /className="([^"]*focus-within:ring-blue-500\/70[^"]*)"/,
    tag: 'input',
    nested: true,
  },
  {
    name: 'project space sorting',
    source: sources.projectSpace,
    expression: /className="([^"]*focus-visible:ring-blue-500\/70[^"]*)"/,
    tag: 'select',
    nested: false,
  },
])(
  '$name preserves the pointer baseline and keyboard ring',
  ({ source, expression, tag, nested }) => {
    const classes = sourceClass(source, expression)
    const markup = nested ? container(classes, `<${tag} data-focus></${tag}>`) : field(classes, tag)
    const { pointer } = expectPointerBaseline(markup)
    for (const modality of ['keyboard', undefined] as const) {
      expect(computed(markup, modality).ring).not.toBe(pointer.ring)
    }
  }
)

test.each(['projects', 'branches'] as const)(
  'floating %s source retains its translucent base border and gates focus paint',
  source => {
    const classes = sourceClass(sources[source], /<label className="([^"]*border-border\/70[^"]*)"/)
    expect(classes.split(/\s+/)).toEqual(
      expect.arrayContaining(['border-border/70', 'keyboard:focus-within:border-focus'])
    )
    expect(classes.split(/\s+/)).not.toContain('focus-within:border-focus')
  }
)

test('the real validation branch keeps its error border and ring for pointer input', () => {
  const branches = sources.errors.match(
    /className={\[\s*'([^']+)',\s*sourceError\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/
  )
  expect(branches).not.toBeNull()
  const [, common, error, normal] = branches!
  expectPointerBaseline(field(`${common} ${normal}`))
  const errorMarkup = field(`${common} ${error}`)
  const baseline = computed(errorMarkup, 'pointer', { focus: false })
  const pointer = computed(errorMarkup, 'pointer')
  expect(pointer.ring).not.toBe(baseline.ring)
  expect(pointer.ringColor).toMatch(/239[ ,]+68[ ,]+68/)
  expect(pointer.border).not.toBe(baseline.border)
})

test('static selection rings survive pointer focus unchanged', () => {
  const markup = field('ring-2 ring-focus/20 shadow-sm')
  const { baseline } = expectPointerBaseline(markup)
  expect(baseline.ring).not.toBe('')
  expect(baseline.ring).not.toBe('0 0 #0000')
})

test('intentional neutral focus rings remain available for pointer input', () => {
  const markup = field('focus:ring-2 focus:ring-border/60')
  const baseline = computed(markup, 'pointer', { focus: false })
  const pointer = computed(markup, 'pointer')
  expect(pointer.ring).not.toBe(baseline.ring)
  expect(pointer.ringColor).not.toBe('')
  expect(pointer.ringColor).toBe(computed(markup, 'keyboard').ringColor)
})

test('DSH pointer suppression changes its token without overwriting explicit error outlines', () => {
  // Set a local token because jsdom does not reliably inherit custom properties.
  const ordinary = field('focus-token-baseline')
  expect(computed(ordinary, 'pointer').dshColor).toBe('transparent')
  for (const modality of ['keyboard', undefined] as const) {
    expect(computed(ordinary, modality).dshColor).toBe('rgb(51, 156, 255)')
  }
  const error = field('focus-visible:outline-2 focus-visible:outline-red-500')
  expect(computed(error, 'pointer').outlineColor).toMatch(/239[ ,]+68[ ,]+68/)
  expect(computed(error, 'pointer').outlineColor).toBe(computed(error, 'keyboard').outlineColor)
})

test('pointer suppression preserves focus backgrounds instead of disabling every focus rule', () => {
  const classes = sourceClass(
    sources.browser,
    /className="([^"]*workbench-chrome-input[^"\n]*focus:bg-background[^"\n]*)"/
  )
  expect(classes.split(/\s+/)).toContain('focus:bg-background')
  // jsdom cannot resolve rgb(var(...)) colors, so exercise the variant with literals.
  const markup = field('bg-[#ffffff] focus:bg-[#eeeeee]')
  const baseline = computed(markup, 'pointer', { focus: false })
  const pointer = computed(markup, 'pointer')
  expect(baseline.background).toMatch(/255[ ,]+255[ ,]+255/)
  expect(pointer.background).toMatch(/238[ ,]+238[ ,]+238/)
  expect(pointer.background).not.toBe(baseline.background)
  expect(baseline.background).toBe('rgb(255, 255, 255)')
  expect(pointer.background).toBe('rgb(238, 238, 238)')
  expect(pointer.background).toBe(computed(markup, 'keyboard').background)
  expect(pointer.borderWidth).toBe(baseline.borderWidth)
})

test('focus can still reveal actions in pointer mode', () => {
  const markup =
    '<div class="group"><input data-focus><button data-target class="opacity-0 group-focus-within:opacity-100">Action</button></div>'
  expect(computed(markup, 'pointer', { focus: false }).opacity).toBe('0')
  expect(computed(markup, 'pointer').opacity).toBe('1')
  expect(computed(markup, 'keyboard').opacity).toBe('1')
})

test('Issue title blue shadows belong to keyboard mode', () => {
  const markup = field('task-detail-title')
  const baseline = computed(markup, 'pointer', { focus: false })
  const pointer = computed(markup, 'pointer')
  expect(pointer.shadow).toBe(baseline.shadow)
  expect(computed(markup, 'keyboard').shadow).not.toBe(pointer.shadow)
})

test('document source retains its outer border and gates the keyboard cue', () => {
  const classes = sourceClass(
    sources.composer,
    /'([^']*rounded-2xl border border-border\/60[^']*)'/
  )
  expect(classes.split(/\s+/)).toEqual(
    expect.arrayContaining(['border-border/60', 'keyboard:focus-within:border-focus/70'])
  )
  expect(classes.split(/\s+/)).not.toContain('focus-within:border-focus/70')
})

test('configuration composer backgrounds round their top corners without adding a border', () => {
  const classes = sourceClass(
    sources.composer,
    /const surfaceClassName = cn\([\s\S]*?presentation === 'configuration'\s*\? '([^']+)'/
  )
  const state = computed(container(classes), 'pointer')
  expect(state.radius).toBe('0.75rem')
  expect(classes.split(/\s+/)).not.toContain('border')
})
