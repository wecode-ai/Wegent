import { hexToRgbTriplet } from "./color";
import { darkPalette, lightPalette, defaultThemeAppearance } from "./presets";
import { resolveUiTypographyVariables } from "./typography";
import type {
  ThemePalette,
  ThemeAppearance,
  ResolvedAppearanceMode,
} from "./types";

const PALETTE_VARIABLES: Record<keyof ThemePalette, string> = {
  bgBase: "--color-bg-base",
  bgSurface: "--color-bg-surface",
  bgMuted: "--color-muted",
  bgHover: "--color-bg-hover",
  sidebar: "--color-sidebar",
  sidebarActive: "--color-sidebar-active",
  sidebarHover: "--color-sidebar-hover",
  sidebarTextPrimary: "--color-sidebar-text-primary",
  sidebarTextSecondary: "--color-sidebar-text-secondary",
  sidebarTextMuted: "--color-sidebar-text-muted",
  mobileDrawer: "--color-mobile-drawer",
  border: "--color-border",
  textPrimary: "--color-text-primary",
  textSecondary: "--color-text-secondary",
  textMuted: "--color-text-muted",
  primary: "--color-primary",
  primaryContrast: "--color-primary-contrast",
  popover: "--color-popover",
  codeBg: "--color-code-bg",
};

/** The desktop appearance contract, also used by the scoped Web collaboration theme. */
export function resolveThemeVariables(
  resolvedMode: ResolvedAppearanceMode,
  appearance: ThemeAppearance = defaultThemeAppearance,
): Record<`--${string}`, string> {
  const defaultPalette = resolvedMode === "dark" ? darkPalette : lightPalette;
  const palette = {
    ...(resolvedMode === "dark" ? appearance.dark : appearance.light),
    primary: hexToRgbTriplet(appearance.accentColor),
  };
  if (!palette.mobileDrawer || palette.mobileDrawer.includes("/")) {
    palette.mobileDrawer = defaultPalette.mobileDrawer;
  }
  const destructive = resolvedMode === "dark" ? "248 113 113" : "220 38 38";
  return {
    ...Object.fromEntries(
      Object.entries(PALETTE_VARIABLES).map(([key, variable]) => [
        variable,
        palette[key as keyof ThemePalette],
      ]),
    ),
    "--color-bg-muted": palette.bgMuted,
    "--color-bg-subtle": palette.bgMuted,
    "--color-background": palette.bgBase,
    "--color-border-strong": palette.border,
    "--color-focus": "51 156 255",
    "--color-focus-ring": "51 156 255",
    "--color-link": "51 156 255",
    "--color-success": resolvedMode === "dark" ? "64 201 119" : "0 162 64",
    "--color-destructive": destructive,
    "--color-error": destructive,
    "--color-text-inverted": palette.bgBase,
    "--color-popover-foreground": palette.textPrimary,
    "--color-reasoning-standard": "59 130 246",
    "--color-reasoning-ultra-start":
      resolvedMode === "dark" ? "59 130 246" : "37 99 235",
    "--color-reasoning-ultra-end":
      resolvedMode === "dark" ? "192 132 252" : "168 85 247",
    "--color-reasoning-ultra-text":
      resolvedMode === "dark" ? "192 132 252" : "147 51 234",
    "--color-reasoning-contrast": "255 255 255",
    "--font-ui": appearance.uiFont,
    "--font-code": appearance.codeFont,
    "--font-size-ui": `${appearance.uiFontSize}px`,
    "--font-size-code": `${appearance.codeFontSize}px`,
    "--font-weight-ui": "445",
    "--text-chat": `${appearance.uiFontSize}px`,
    "--text-code": `${appearance.codeFontSize}px`,
    "--text-code-sm": `${Math.max(8, appearance.codeFontSize - 1)}px`,
    "--diffs-font-size": `${appearance.codeFontSize}px`,
    ...resolveUiTypographyVariables(appearance.uiFontSize),
    "--appearance-contrast": String(appearance.contrast),
    "--radius": "0.5rem",
    "--radius-default": "0.5rem",
    "--radius-sm": "0.125rem",
  };
}
