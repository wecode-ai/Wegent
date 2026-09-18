import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { resolveThemeVariables } from "./resolveThemeVariables";
import type { ResolvedAppearanceMode, ThemeAppearance } from "./types";

interface ThemeSurfaceProps {
  className: string;
  style?: CSSProperties;
  "data-theme"?: ResolvedAppearanceMode;
}

const ThemeContext = createContext<ThemeSurfaceProps>({ className: "" });

/** Scope the desktop theme without adding a layout box or changing the document theme. */
export function CollaborationTheme({
  mode,
  appearance,
  children,
}: {
  mode: ResolvedAppearanceMode;
  appearance?: ThemeAppearance;
  children: ReactNode;
}) {
  const surface = useMemo<ThemeSurfaceProps>(
    () => ({
      className: `collaboration-theme${mode === "dark" ? " dark" : ""}`,
      "data-theme": mode,
      style: { ...resolveThemeVariables(mode, appearance), colorScheme: mode },
    }),
    [mode, appearance],
  );
  return (
    <ThemeContext.Provider value={surface}>
      <div {...surface} style={{ ...surface.style, display: "contents" }}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** Portals leave the scope's DOM ancestry, so attach the same tokens to their root. */
export function useCollaborationPortalTheme() {
  return useContext(ThemeContext);
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });
  return () => observer.disconnect();
}

function getDocumentTheme(): ResolvedAppearanceMode {
  const root = document.documentElement;
  return root.dataset.theme === "dark" || root.classList.contains("dark")
    ? "dark"
    : "light";
}

const getServerTheme = () => "light" as const;

export function useDocumentTheme() {
  return useSyncExternalStore(subscribeTheme, getDocumentTheme, getServerTheme);
}
