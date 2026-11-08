import { hexToRgbTriplet } from './color'
import { DEFAULT_ACCENT_COLOR, darkPalette, lightPalette } from './presets'
import type { ResolvedAppearanceMode, ThemePalette } from './types'

export const DEFAULT_UI_THEME_ID = 'wework'

export const SYNTAX_COLOR_NAMES = [
  'keyword',
  'string',
  'number',
  'function',
  'type',
  'variable',
  'comment',
  'operator',
  'punctuation',
] as const
export const TERMINAL_COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white',
] as const

export interface ThemeVariant {
  mode: ResolvedAppearanceMode
  palette: ThemePalette
  accentColor: string
  syntax: Record<(typeof SYNTAX_COLOR_NAMES)[number], string>
  terminal: Record<(typeof TERMINAL_COLOR_NAMES)[number], string>
  added: string
  removed: string
  warning: string
}

export interface ThemeDefinition {
  id: string
  label: string
  variants: Partial<Record<ResolvedAppearanceMode, ThemeVariant>>
}

// Color facts were checked against the installed ChatGPT desktop theme catalogue.
// Wework owns the semantic mapping and surface construction below; no application
// code, fonts, icons, or bundled assets from the reference app are used.
type Seed = readonly [
  background: string,
  surface: string,
  foreground: string,
  accent: string,
  keyword: string,
  string: string,
  number: string,
  functionColor: string,
  typeColor: string,
  variable: string,
  comment: string,
  operator: string,
  punctuation: string,
  added: string,
  removed: string,
  warning: string,
]

function mix(first: string, second: string, amount: number): string {
  const a = hexToRgbTriplet(first).split(' ').map(Number)
  const b = hexToRgbTriplet(second).split(' ').map(Number)
  return a.map((value, index) => Math.round(value + (b[index] - value) * amount)).join(' ')
}

export function contrastForegroundColor(rgbTriplet: string): string {
  const channels = rgbTriplet.split(' ').map(value => {
    const channel = Number(value) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  return blackContrast >= whiteContrast ? '0 0 0' : '255 255 255'
}

function variant(mode: ResolvedAppearanceMode, seed: Seed, ansi?: readonly string[]): ThemeVariant {
  const [background, surface, foreground, accent, ...colors] = seed
  const [
    keyword,
    string,
    number,
    functionColor,
    type,
    variable,
    comment,
    operator,
    punctuation,
    added,
    removed,
    warning,
  ] = colors
  const syntaxColors = {
    keyword,
    string,
    number,
    function: functionColor,
    type,
    variable,
    comment,
    operator,
    punctuation,
  }
  const rgb = hexToRgbTriplet
  const dark = mode === 'dark'
  const primaryContrast = contrastForegroundColor(rgb(accent))
  const defaultAnsi = [
    dark ? '#24242c' : '#303038',
    removed,
    added,
    warning,
    accent,
    keyword,
    type,
    foreground,
    comment,
    removed,
    string,
    number,
    functionColor,
    keyword,
    operator,
    foreground,
  ]
  return {
    mode,
    accentColor: accent,
    palette: {
      bgBase: rgb(background),
      bgSurface: rgb(surface),
      bgMuted: mix(background, foreground, dark ? 0.09 : 0.055),
      bgHover: `${rgb(foreground)} / 0.07`,
      sidebar: rgb(surface),
      sidebarActive: `${rgb(foreground)} / 0.1`,
      sidebarHover: `${rgb(foreground)} / 0.06`,
      sidebarTextPrimary: rgb(foreground),
      sidebarTextSecondary: mix(surface, foreground, 0.75),
      sidebarTextMuted: mix(surface, foreground, 0.55),
      mobileDrawer: rgb(surface),
      border: mix(background, foreground, dark ? 0.14 : 0.13),
      textPrimary: rgb(foreground),
      textSecondary: mix(background, foreground, 0.75),
      textMuted: mix(background, foreground, 0.55),
      primary: rgb(accent),
      primaryContrast,
      popover: rgb(surface),
      codeBg: rgb(background),
    },
    syntax: Object.fromEntries(
      SYNTAX_COLOR_NAMES.map(name => [name, rgb(syntaxColors[name])])
    ) as ThemeVariant['syntax'],
    terminal: Object.fromEntries(
      TERMINAL_COLOR_NAMES.map((name, index) => [name, rgb(ansi?.[index] ?? defaultAnsi[index])])
    ) as ThemeVariant['terminal'],
    added: rgb(added),
    removed: rgb(removed),
    warning: rgb(warning),
  }
}

const define = (
  id: string,
  label: string,
  light?: Seed,
  dark?: Seed,
  terminal?: Partial<Record<ResolvedAppearanceMode, readonly string[]>>
): ThemeDefinition => ({
  id,
  label,
  variants: {
    ...(light ? { light: variant('light', light, terminal?.light) } : {}),
    ...(dark ? { dark: variant('dark', dark, terminal?.dark) } : {}),
  },
})

// Keep the color-fact table aligned with the Seed column contract above.
// prettier-ignore
export const UI_THEME_CATALOGUE: readonly ThemeDefinition[] = [
  {
    id: DEFAULT_UI_THEME_ID,
    label: 'Wework',
    variants: {
      light: {
        ...variant('light', ['#ffffff','#f7f7f8','#1a1a1a',DEFAULT_ACCENT_COLOR,'#0000ff','#a31515','#098658','#795e26','#267f99','#001080','#008000','#1a1a1a','#1a1a1a','#00a240','#dc2626','#b45309']),
        palette: lightPalette,
      },
      dark: {
        ...variant('dark', ['#181818','#212121','#ffffff',DEFAULT_ACCENT_COLOR,'#569cd6','#ce9178','#b5cea8','#dcdcaa','#4ec9b0','#9cdcfe','#6a9955','#d4d4d4','#d4d4d4','#40c977','#f87171','#fbbf24']),
        palette: darkPalette,
      },
    },
  },
  define('absolutely', 'Absolutely',
    ['#f9f9f7','#f4f4f2','#2d2d2b','#cc7d5e','#ff5f38','#00c853','#ff5f38','#2d2d2b','#bc7559','#2d2d2b','#939391','#bc7559','#939391','#008e3d','#d53538','#b67b00'],
    ['#2d2d2b','#373735','#f9f9f7','#cc7d5e','#ff5f38','#00c853','#ff5f38','#f9f9f7','#d28e73','#f9f9f7','#b2b2b0','#d28e73','#b2b2b0','#00c853','#ff5f38','#e5b95c']),
  define('ayu', 'Ayu', undefined,
    ['#10141c','#0d1017','#bfbdb6','#e6b450','#ff8f40','#aad94c','#d2a6ff','#ffb454','#59c2ff','#bfbdb6','#5a6673','#f29668','#bfbdb6','#70bf56','#f26d78','#fdb04c'],
    {dark:['#1b1f29','#f06b73','#70bf56','#fdb04c','#4fbfff','#d0a1ff','#93e2c8','#c7c7c7','#686868','#f07178','#aad94c','#ffb454','#59c2ff','#d2a6ff','#95e6cb','#ffffff']}),
  define('catppuccin', 'Catppuccin',
    ['#eff1f5','#e6e9ef','#4c4f69','#8839ef','#8839ef','#40a02b','#fe640b','#1e66f5','#df8e1d','#4c4f69','#7c7f93','#179299','#7c7f93','#40a02b','#d20f39','#df8e1d'],
    ['#1e1e2e','#181825','#cdd6f4','#cba6f7','#cba6f7','#a6e3a1','#fab387','#89b4fa','#f9e2af','#cdd6f4','#9399b2','#94e2d5','#9399b2','#a6e3a1','#f38ba8','#f9e2af'],
    {light:['#5c5f77','#d20f39','#40a02b','#df8e1d','#1e66f5','#ea76cb','#179299','#acb0be','#6c6f85','#de293e','#49af3d','#eea02d','#456eff','#fe85d8','#2d9fa8','#bcc0cc'],dark:['#45475a','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5','#a6adc8','#585b70','#f37799','#89d88b','#ebd391','#74a8fc','#f2aede','#6bd7ca','#bac2de']}),
  define('codex', 'ChatGPT',
    ['#ffffff','#fcfcfc','#0d0d0d','#0169cc','#d53538','#008809','#0071ea','#751ed9','#751ed9','#bd5800','#666666','#666666','#666666','#00a240','#e02e2a','#bd5800'],
    ['#111111','#131313','#fcfcfc','#0169cc','#f67576','#85df7b','#6dcbf4','#b06dff','#b06dff','#fa994c','#999999','#999999','#999999','#00a240','#e02e2a','#fa994c']),
  define('dracula', 'Dracula', undefined,
    ['#282a36','#21222c','#f8f8f2','#ff79c6','#ff79c6','#f1fa8c','#bd93f9','#50fa7b','#8be9fd','#f8f8f2','#6272a4','#ff79c6','#f8f8f2','#50fa7b','#ff5555','#f1fa8c'],
    {dark:['#21222c','#ff5555','#50fa7b','#f1fa8c','#bd93f9','#ff79c6','#8be9fd','#f8f8f2','#6272a4','#ff6e6e','#69ff94','#ffffa5','#d6acff','#ff92df','#a4ffff','#ffffff']}),
  define('everforest', 'Everforest',
    ['#fdf6e3','#fdf6e3','#5c6a72','#93b259','#f85552','#8da101','#df69ba','#8da101','#dfa000','#5c6a72','#939f91','#f57d26','#5c6a72','#8da101','#f85552','#dfa000'],
    ['#2d353b','#2d353b','#d3c6aa','#a7c080','#e67e80','#a7c080','#d699b6','#a7c080','#dbbc7f','#d3c6aa','#859289','#e69875','#d3c6aa','#a7c080','#e67e80','#dbbc7f'],
    {light:['#5c6a72','#f85552','#8da101','#dfa000','#3a94c5','#df69ba','#35a77c','#939f91','#5c6a72','#f85552','#8da101','#dfa000','#3a94c5','#df69ba','#35a77c','#f4f0d9'],dark:['#343f44','#e67e80','#a7c080','#dbbc7f','#7fbbb3','#d699b6','#83c092','#d3c6aa','#859289','#e67e80','#a7c080','#dbbc7f','#7fbbb3','#d699b6','#83c092','#d3c6aa']}),
  define('github', 'GitHub',
    ['#ffffff','#f6f8fa','#1f2328','#0969da','#cf222e','#0a3069','#0550ae','#8250df','#953800','#953800','#6e7781','#cf222e','#1f2328','#1a7f37','#cf222e','#9a6700'],
    ['#0d1117','#010409','#e6edf3','#1f6feb','#ff7b72','#a5d6ff','#79c0ff','#d2a8ff','#ffa657','#ffa657','#8b949e','#ff7b72','#e6edf3','#3fb950','#f85149','#d29922'],
    {light:['#24292f','#cf222e','#116329','#4d2d00','#0969da','#8250df','#1b7c83','#6e7781','#57606a','#a40e26','#1a7f37','#633c01','#218bff','#a475f9','#3192aa','#8c959f'],dark:['#484f58','#ff7b72','#3fb950','#d29922','#58a6ff','#bc8cff','#39c5cf','#b1bac4','#6e7681','#ffa198','#56d364','#e3b341','#79c0ff','#d2a8ff','#56d4dd','#ffffff']}),
  define('gruvbox', 'Gruvbox',
    ['#fbf1c7','#fbf1c7','#3c3836','#458588','#9d0006','#79740e','#8f3f71','#b57614','#b57614','#076678','#928374','#427b58','#7c6f64','#79740e','#cc241d','#b57614'],
    ['#282828','#282828','#ebdbb2','#458588','#fb4934','#b8bb26','#d3869b','#fabd2f','#fabd2f','#83a598','#928374','#8ec07c','#a89984','#b8bb26','#cc241d','#fabd2f'],
    {light:['#ebdbb2','#cc241d','#98971a','#d79921','#458588','#b16286','#689d6a','#7c6f64','#928374','#9d0006','#79740e','#b57614','#076678','#8f3f71','#427b58','#3c3836'],dark:['#3c3836','#cc241d','#98971a','#d79921','#458588','#b16286','#689d6a','#a89984','#928374','#fb4934','#b8bb26','#fabd2f','#83a598','#d3869b','#8ec07c','#ebdbb2']}),
  define('linear', 'Linear',
    ['#fcfcfd','#f2f4f8','#1b1b1b','#5e6ad2','#5e6ad2','#0f8f83','#b4831f','#8160d8','#4380d8','#2a3140','#8a93a6','#6f7788','#6f7788','#52a450','#c94446','#b4831f'],
    ['#0f0f11','#080a0f','#e3e4e6','#606acc','#8c97ff','#7ad9c0','#f5c56a','#c2a1ff','#73b7ff','#e6e9ef','#636b7b','#b5bccb','#b5bccb','#69c967','#ff7e78','#f5c56a']),
  define('lobster', 'Lobster', undefined,
    ['#111827','#111827','#e4e4e7','#ff5c5c','#ff5c5c','#14b8a6','#f59e0b','#22c55e','#3b82f6','#e4e4e7','#71717a','#ff7070','#71717a','#22c55e','#ff5c5c','#f59e0b']),
  define('material', 'Material', undefined,
    ['#212121','#212121','#eeffff','#80cbc4','#c792ea','#c3e88d','#f78c6c','#82aaff','#ffcb6b','#eeffff','#545454','#89ddff','#89ddff','#c3e88d','#f07178','#ffcb6b'],
    {dark:['#000000','#f07178','#c3e88d','#ffcb6b','#82aaff','#c792ea','#89ddff','#ffffff','#545454','#f07178','#c3e88d','#ffcb6b','#82aaff','#c792ea','#89ddff','#ffffff']}),
  define('matrix', 'Matrix', undefined,
    ['#040805','#020402','#b8ffca','#1eff5a','#1eff5a','#7dff95','#55ff7d','#9bffb8','#3adf6a','#b8ffca','#3f8f52','#6bd985','#6bd985','#55ff7d','#ff6b6b','#e4f222']),
  define('monokai', 'Monokai', undefined,
    ['#272822','#1e1f1c','#f8f8f2','#a6e22e','#f92672','#e6db74','#ae81ff','#a6e22e','#66d9ef','#f8f8f2','#88846f','#f92672','#f8f8f2','#86b42b','#c4265e','#e6db74'],
    {dark:['#333333','#c4265e','#86b42b','#b3b42b','#6a7ec8','#8c6bc8','#56adbc','#e3e3dd','#666666','#f92672','#a6e22e','#e2e22e','#819aff','#ae81ff','#66d9ef','#f8f8f2']}),
  define('night-owl', 'Night Owl', undefined,
    ['#011627','#011627','#d6deeb','#82aaff','#c792ea','#ecc48d','#f78c6c','#c792ea','#82aaff','#c5e478','#637777','#7fdbca','#d6deeb','#22da6e','#ef5350','#ffeb95'],
    {dark:['#011627','#ef5350','#22da6e','#c5e478','#82aaff','#c792ea','#21c7a8','#ffffff','#575656','#ef5350','#22da6e','#ffeb95','#82aaff','#c792ea','#7fdbca','#ffffff']}),
  define('nord', 'Nord', undefined,
    ['#2e3440','#2e3440','#d8dee9','#88c0d0','#81a1c1','#a3be8c','#b48ead','#88c0d0','#8fbcbb','#d8dee9','#616e88','#81a1c1','#eceff4','#a3be8c','#bf616a','#ebcb8b'],
    {dark:['#3b4252','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#88c0d0','#e5e9f0','#4c566a','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#8fbcbb','#eceff4']}),
  define('notion', 'Notion',
    ['#ffffff','#f7f6f3','#37352f','#3183d8','#0000ff','#a31515','#098658','#795e26','#267f99','#37352f','#008000','#37352f','#37352f','#098658','#a31515','#b57614'],
    ['#191919','#151515','#d9d9d8','#3183d8','#569cd6','#ce9178','#b5cea8','#dcdcaa','#4ec9b0','#d9d9d8','#6a9955','#d4d4d4','#d4d4d4','#b5cea8','#f48771','#dcdcaa']),
  define('og', 'OG', undefined,
    ['#343541','#202123','#d1d5db','#10a37f','#b4a1e5','#65c99a','#f8b86f','#8dc8f4','#8bd5ca','#d1d5db','#acacbe','#d1d5db','#d1d5db','#65c99a','#f28b82','#f8b86f']),
  define('oscurange', 'Oscurange', undefined,
    ['#0b0b0f','#0b0b0f','#e6e6e6','#f9b98c','#9099a1','#e6e6e6','#f9b98c','#f9b98c','#5c6974','#e6e6e6','#46474f','#9099a1','#5c6974','#8fc88d','#e08a83','#f9b98c']),
  define('one', 'One',
    ['#fafafa','#eaeaeb','#383a42','#526fff','#a626a4','#50a14f','#986801','#4078f2','#c18401','#e45649','#a0a1a7','#383a42','#383a42','#50a14f','#e45649','#986801'],
    ['#282c34','#21252b','#abb2bf','#4d78cc','#c678dd','#98c379','#d19a66','#61afef','#e5c07b','#e06c75','#5c6370','#abb2bf','#abb2bf','#8cc265','#e05561','#e5c07b'],
    {dark:['#3f4451','#e05561','#8cc265','#d18f52','#4aa5f0','#c162de','#42b3c2','#d7dae0','#4f5666','#ff616e','#a5e075','#f0a45d','#4dc4ff','#de73ff','#4cd1e0','#e6e6e6']}),
  define('proof', 'Proof',
    ['#f5f3ed','#efede6','#2f312d','#3d755d','#5f6ac2','#3d755d','#d3b45b','#3d755d','#5f6ac2','#2f312d','#8b877c','#7a766d','#7a766d','#3d755d','#b44d4d','#9a7b20']),
  define('raycast', 'Raycast',
    ['#ffffff','#fcfcfc','#030303','#ff6363','#666666','#c03030','#000000','#c75d07','#c75d07','#000000','#999999','#666666','#666666','#006b4f','#b12424','#f8a300'],
    ['#101010','#101010','#fefefe','#ff6363','#999999','#ff6363','#ffffff','#ff9217','#ff9217','#ffffff','#666666','#999999','#999999','#59d499','#ff6363','#ffc531'],
    {light:['#ffffff','#b12424','#006b4f','#f8a300','#138af2','#9a1b6e','#138af2','#000000','#666666','#b12424','#006b4f','#f8a300','#138af2','#9a1b6e','#138af2','#000000'],dark:['#000000','#ff6363','#59d499','#ffc531','#56c2ff','#cf2f98','#56c2ff','#ffffff','#666666','#ff6363','#59d499','#ffc531','#56c2ff','#cf2f98','#56c2ff','#ffffff']}),
  define('rose-pine', 'Rose Pine',
    ['#faf4ed','#faf4ed','#575279','#d7827e','#286983','#ea9d34','#d7827e','#907aa9','#56949f','#d7827e','#9893a5','#286983','#797593','#56949f','#b4637a','#ea9d34'],
    ['#232136','#232136','#e0def4','#ea9a97','#3e8fb0','#f6c177','#ea9a97','#c4a7e7','#9ccfd8','#ea9a97','#6e6a86','#3e8fb0','#908caa','#9ccfd8','#eb6f92','#f6c177'],
    {light:['#f2e9e1','#b4637a','#286983','#ea9d34','#56949f','#907aa9','#d7827e','#575279','#797593','#b4637a','#286983','#ea9d34','#56949f','#907aa9','#d7827e','#575279'],dark:['#393552','#eb6f92','#3e8fb0','#f6c177','#9ccfd8','#c4a7e7','#ea9a97','#e0def4','#908caa','#eb6f92','#3e8fb0','#f6c177','#9ccfd8','#c4a7e7','#ea9a97','#e0def4']}),
  define('sentry', 'Sentry', undefined,
    ['#2d2935','#26222d','#e6dff9','#7055f6','#7055f6','#8ee6d7','#f4c46a','#a58cff','#c39bff','#e6dff9','#8d849f','#c8bedf','#c8bedf','#8ee6d7','#f78c8c','#f4c46a']),
  define('solarized', 'Solarized',
    ['#fdf6e3','#eee8d5','#657b83','#b58900','#859900','#2aa198','#d33682','#268bd2','#cb4b16','#657b83','#93a1a1','#859900','#657b83','#859900','#dc322f','#b58900'],
    ['#002b36','#00212b','#839496','#268bd2','#859900','#2aa198','#d33682','#268bd2','#cb4b16','#839496','#586e75','#859900','#839496','#859900','#dc322f','#b58900'],
    {light:['#073642','#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198','#eee8d5','#002b36','#cb4b16','#586e75','#657b83','#839496','#6c71c4','#93a1a1','#fdf6e3'],dark:['#073642','#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198','#eee8d5','#002b36','#cb4b16','#586e75','#657b83','#839496','#6c71c4','#93a1a1','#fdf6e3']}),
  define('temple', 'Temple', undefined,
    ['#02120c','#1d2d0f','#c7e6da','#e4f222','#e4f222','#e4f222','#e4f222','#e4f222','#859419','#c7e6da','#394d46','#788617','#4f5e13','#93c572','#f08080','#e4f222']),
  define('tokyo-night', 'Tokyo Night', undefined,
    ['#1a1b26','#16161e','#a9b1d6','#7aa2f7','#bb9af7','#9ece6a','#ff9e64','#7aa2f7','#2ac3de','#c0caf5','#51597d','#89ddff','#89ddff','#449dab','#914c54','#e0af68'],
    {dark:['#363b54','#f7768e','#73daca','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#787c99','#363b54','#f7768e','#73daca','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#acb0d0']}),
  define('vercel', 'Vercel',
    ['#ffffff','#ffffff','#171717','#006aff','#006aff','#28a948','#a100f8','#a100f8','#0059d1','#171717','#666666','#666666','#666666','#28a948','#eb001d','#b38300'],
    ['#000000','#000000','#ededed','#006efe','#006efe','#00ad3a','#9540d5','#9540d5','#52a8ff','#ededed','#666666','#a1a1a1','#a1a1a1','#00ad3a','#f13342','#e7b200']),
  define('vscode-plus', 'VS Code Plus',
    ['#ffffff','#f3f3f3','#000000','#007acc','#0000ff','#a31515','#098658','#795e26','#267f99','#001080','#008000','#000000','#000000','#098658','#a31515','#795e26'],
    ['#1e1e1e','#252526','#d4d4d4','#007acc','#569cd6','#ce9178','#b5cea8','#dcdcaa','#4ec9b0','#9cdcfe','#6a9955','#d4d4d4','#d4d4d4','#73c991','#f48771','#dcdcaa']),
  define('xcode', 'Xcode',
    ['#ffffff','#ffffff','#000000','#0e0eff','#9b2393','#c41a16','#1c00cf','#326d74','#0b4f79','#326d74','#5d6c79','#000000','#000000','#326d74','#c41a16','#946400'],
    ['#1f1f24','#1f1f24','#ffffff','#5482ff','#fc5fa3','#fc6a5d','#d0bf69','#67b7a4','#5dd8ff','#67b7a4','#6c7986','#ffffff','#ffffff','#67b7a4','#fc6a5d','#d0bf69']),
]

export function getUiTheme(
  id: string,
  mode: ResolvedAppearanceMode
): ThemeDefinition & { variant: ThemeVariant } {
  const theme =
    UI_THEME_CATALOGUE.find(item => item.id === id && item.variants[mode]) ??
    UI_THEME_CATALOGUE.find(item => item.id === DEFAULT_UI_THEME_ID)!
  return { ...theme, variant: theme.variants[mode]! }
}

export function resolveUiThemeVariables(
  mode: ResolvedAppearanceMode,
  themeId: string
): Record<`--${string}`, string> {
  const { variant: theme } = getUiTheme(themeId, mode)
  const variables: Record<`--${string}`, string> = {
    '--color-titlebar': theme.palette.bgSurface,
    '--color-diff-added': theme.added,
    '--color-diff-removed': theme.removed,
    '--color-warning': theme.warning,
    '--color-info': theme.palette.primary,
    '--color-overlay': '0 0 0',
    '--color-success': theme.added,
    '--color-destructive': theme.removed,
    '--color-error': theme.removed,
    '--color-destructive-contrast': contrastForegroundColor(theme.removed),
    '--color-success-contrast': contrastForegroundColor(theme.added),
    '--color-focus': theme.palette.primary,
    '--color-focus-ring': theme.palette.primary,
    '--color-link': theme.palette.primary,
    '--color-scrollbar-thumb': `${theme.palette.textPrimary} / 0.22`,
    '--color-scrollbar-thumb-hover': `${theme.palette.textPrimary} / 0.38`,
  }
  for (const name of SYNTAX_COLOR_NAMES) variables[`--color-syntax-${name}`] = theme.syntax[name]
  for (const name of TERMINAL_COLOR_NAMES)
    variables[`--color-terminal-${name}`] = theme.terminal[name]
  return variables
}
