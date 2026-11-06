// Loaded before styles so the first painted startup frame uses the saved palette.
const appearanceRoot = document.documentElement
let appliedAppearanceVariables = []

function applyHostAppearance(appearance) {
  const mode = appearance?.mode === 'dark' ? 'dark' : 'light'
  appearanceRoot.dataset.theme = mode
  appearanceRoot.dataset.appearanceTheme = appearance?.themeId ?? 'codex'
  appearanceRoot.dataset.uiThemeId = appearanceRoot.dataset.appearanceTheme
  appearanceRoot.style.colorScheme = mode
  for (const variable of appliedAppearanceVariables) appearanceRoot.style.removeProperty(variable)
  const variables = Object.entries(appearance?.variables ?? {})
  for (const [name, value] of variables) appearanceRoot.style.setProperty(name, value)
  appliedAppearanceVariables = variables.map(([name]) => name)
}

const appearanceParameters = new URLSearchParams(window.location.search)
const savedAppearance = appearanceParameters.get('appearance')
applyHostAppearance(
  savedAppearance
    ? JSON.parse(savedAppearance)
    : { mode: appearanceParameters.get('theme'), variables: {} }
)
window.weworkAppearance?.onChanged(applyHostAppearance)
