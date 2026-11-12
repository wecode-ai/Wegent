import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig'
import { afterEach, beforeAll, expect, test } from 'vitest'

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
  email: readSource('src/features/todo/StandInEmailConnections.tsx'),
}
const variants = `
  border border-[#737373]/[.37] keyboard:focus:border-[#339cff]/70
  border-transparent border-0 keyboard:focus-visible:ring-2
  keyboard:focus-visible:ring-focus/70 keyboard:focus-visible:ring-offset-2
  keyboard:focus:ring-2 keyboard:focus:ring-focus/20 shadow-sm ring-2 ring-focus/20
  focus:ring-2 focus:ring-red-500/15 focus:border-red-500
  focus:ring-border/60 group group-focus-within:opacity-100 opacity-0
  focus-visible:outline-2 focus-visible:outline-red-500 bg-[#ffffff] focus:bg-[#eeeeee]
  focus-visible:outline focus-visible:outline-offset-2
`
let css = ''
type Modality = 'pointer' | 'keyboard' | undefined

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

function computed(markup: string, modality: Modality, { focus = true, theme = 'light' } = {}) {
  // This checks cascade results; jsdom does not composite variable-based shadows.
  // Real pointer/Tab events and the rendered ring layers need browser verification.
  // A fresh document avoids jsdom's stale selector cache after modality changes.
  const frame = document.createElement('iframe')
  document.body.append(frame)
  try {
    const copy = frame.contentDocument!
    if (modality) copy.documentElement.dataset.inputModality = modality
    copy.documentElement.classList.toggle('dark', theme === 'dark')
    const style = copy.createElement('style')
    style.textContent = css
    copy.head.append(style)
    copy.body.innerHTML = markup
    const target = copy.querySelector<HTMLElement>('[data-target]')!
    const control = copy.querySelector<HTMLElement>('[data-focus]')!
    if (focus) {
      control.focus()
      expect(copy.activeElement).toBe(control)
      expect(control.matches(':focus-visible')).toBe(true)
    }
    const result = frame.contentWindow!.getComputedStyle(target)
    const property = (name: string) => result.getPropertyValue(name).trim()
    return {
      border: result.borderColor,
      borderWidth: result.borderTopWidth,
      background: result.backgroundColor,
      opacity: result.opacity,
      outlineColor: result.outlineColor,
      outlineStyle: result.outlineStyle,
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
    frame.remove()
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
  // jsdom's computed styles reject modern rgb() syntax, even when :focus matches.
  // Preserve concrete utility colors using the equivalent legacy rgba() notation.
  compiled.walkDecls(declaration => {
    declaration.value = declaration.value.replace(
      /rgb\((\d+) (\d+) (\d+) \/ (var\((--tw-(?:bg|border)-opacity), ([\d.]+)\)|[\d.]+)\)/g,
      (original, red, green, blue, alpha, variable, fallback) => {
        if (variable) {
          const opacity = declaration.parent?.nodes.find(
            node => node.type === 'decl' && node.prop === variable
          )
          alpha = opacity?.type === 'decl' ? opacity.value : fallback
        }
        return /^[\d.]+$/.test(alpha) ? `rgba(${red}, ${green}, ${blue}, ${alpha})` : original
      }
    )
  })
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
    /* Model the lower-priority UA outline without adding author specificity. */
    :where(input, textarea, select):focus-visible {
      outline-style: auto;
      outline-offset: -2px;
    }
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
})

afterEach(() => document.body.replaceChildren())

test.each(['light', 'dark'])('%s native form fields keep their pointer border', theme => {
  const classes = sourceClass(sources.email, /className="([^"]*border border-border[^"]*)"/)
  for (const tag of ['input', 'textarea', 'select']) {
    const markup = field(classes, tag)
    const { pointer } = expectPointerBaseline(markup, theme)
    expect(pointer.borderWidth).toBe('1px')
    expect(pointer.outlineStyle).toBe('none')
    for (const modality of ['keyboard', undefined] as const) {
      expect(computed(markup, modality, { theme }).outlineStyle).toBe('auto')
    }
  }
})

test('pointer focus preserves explicit validation outlines', () => {
  const style = computed(
    field(
      'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500 focus-visible:outline-offset-2'
    ),
    'pointer'
  )
  expect(style.outlineStyle).toBe('solid')
  expect(style.outlineColor).toBe('rgb(239, 68, 68)')
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
    expression: /className="([^"]*focus-within:ring-focus\/70[^"]*)"/,
    tag: 'input',
    nested: true,
  },
  {
    name: 'project space sorting',
    source: sources.projectSpace,
    expression: /className="([^"]*focus-visible:ring-focus\/70[^"]*)"/,
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
