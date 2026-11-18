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

type Rgb = [number, number, number];

function rgb(value: string): Rgb {
  return value.split(/\s+/).map(Number) as Rgb;
}

function blend(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) => channel * alpha + background[index] * (1 - alpha),
  ) as Rgb;
}

function luminance(color: Rgb): number {
  const linear = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

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
    "defines distinct PR status tones in %s mode",
    (mode) => {
      const variables = resolveThemeVariables(mode);
      expect(variables["--color-info"]).toBeTruthy();
      expect(variables["--color-success"]).toBeTruthy();
      expect(variables["--color-warning"]).toBeTruthy();
      expect(variables["--color-destructive"]).toBeTruthy();
      expect(variables["--color-merged"]).toBeTruthy();
      expect(variables["--color-merged"]).not.toBe(
        variables["--color-success"],
      );
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps compact success and warning badges above WCAG AA in %s mode",
    (mode) => {
      const variables = resolveThemeVariables(mode);
      const page = rgb(variables["--color-bg-base"]);
      const muted = blend(rgb(variables["--color-muted"]), page, 0.4);
      expect(
        contrastRatio(rgb(variables["--color-success-foreground"]), muted),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(rgb(variables["--color-warning-foreground"]), muted),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

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
