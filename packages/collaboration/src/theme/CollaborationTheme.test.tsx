// @vitest-environment jsdom

import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CollaborationTheme,
  useCollaborationPortalTheme,
} from "./CollaborationTheme";
import { resolveThemeVariables } from "./resolveThemeVariables";

function Portal() {
  const theme = useCollaborationPortalTheme();
  return createPortal(
    <div {...theme} data-testid="theme-portal" />,
    document.body,
  );
}

describe("CollaborationTheme portal variables", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each(["light", "dark"] as const)(
    "preserves every default %s variable without overrides",
    async (mode) => {
      await act(async () =>
        root.render(
          <CollaborationTheme mode={mode}>
            <Portal />
          </CollaborationTheme>,
        ),
      );
      const portal = document.querySelector<HTMLElement>(
        '[data-testid="theme-portal"]',
      )!;
      expect(container.contains(portal)).toBe(false);
      expect(portal.dataset.theme).toBe(mode);
      for (const [name, value] of Object.entries(resolveThemeVariables(mode))) {
        expect(portal.style.getPropertyValue(name)).toBe(value);
      }
    },
  );

  it("carries explicit custom variables and restores the default palette when removed", async () => {
    await act(async () =>
      root.render(
        <CollaborationTheme
          mode="light"
          variables={{
            "--color-border-strong": "201 203 208",
            "--color-error": "180 35 24",
            "--experience-text-caption": "10px",
            "--font-ui": "Scoped UI",
          }}
        >
          <Portal />
        </CollaborationTheme>,
      ),
    );
    const portal = document.querySelector<HTMLElement>(
      '[data-testid="theme-portal"]',
    )!;
    expect(portal.style.getPropertyValue("--color-border-strong")).toBe(
      "201 203 208",
    );
    expect(portal.style.getPropertyValue("--color-error")).toBe("180 35 24");
    expect(portal.style.getPropertyValue("--experience-text-caption")).toBe(
      "10px",
    );
    expect(portal.style.getPropertyValue("--font-ui")).toBe("Scoped UI");
    expect(portal.style.getPropertyValue("--text-sm")).toBe(
      resolveThemeVariables("light")["--text-sm"],
    );

    await act(async () =>
      root.render(
        <CollaborationTheme mode="dark">
          <Portal />
        </CollaborationTheme>,
      ),
    );
    expect(portal.style.getPropertyValue("--experience-text-caption")).toBe("");
    for (const [name, value] of Object.entries(resolveThemeVariables("dark"))) {
      expect(portal.style.getPropertyValue(name)).toBe(value);
    }
  });
});
