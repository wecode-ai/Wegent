export type AppearanceMode = "light" | "dark" | "system";
export type ResolvedAppearanceMode = "light" | "dark";

export interface ThemePalette {
  bgBase: string;
  bgSurface: string;
  bgMuted: string;
  bgHover: string;
  sidebar: string;
  sidebarActive: string;
  sidebarHover: string;
  sidebarTextPrimary: string;
  sidebarTextSecondary: string;
  sidebarTextMuted: string;
  mobileDrawer: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryContrast: string;
  popover: string;
  codeBg: string;
}

export interface ThemeAppearance {
  accentColor: string;
  uiFont: string;
  codeFont: string;
  uiFontSize: number;
  codeFontSize: number;
  contrast: number;
  light: ThemePalette;
  dark: ThemePalette;
}
