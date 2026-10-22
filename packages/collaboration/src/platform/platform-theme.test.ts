// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveThemeVariables } from "../theme/resolveThemeVariables";

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const css = source("./base.css") + source("./platform.css");
const surfaces = [
  "collaboration-workspace-starter",
  "collaboration-group-card-grid",
  "collaboration-group-card",
  "collaboration-group-create-main",
  "collaboration-group-create-content",
  "collaboration-group-create-panel",
  "collaboration-group-detail-section collaboration-group-detail-profile",
  "collaboration-group-detail-section collaboration-group-detail-tab-panel",
  "collaboration-group-person-card",
];

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function installTheme(mode: "light" | "dark") {
  const variables = resolveThemeVariables(mode);
  // jsdom does not compute inherited custom properties, so resolve the host
  // tokens and optional primary-action fallbacks before testing the cascade.
  let resolved = css
    .replace(
      /var\((--[\w-]+)\)/g,
      (match, name: string) =>
        variables[name as keyof typeof variables] ?? match,
    )
    .replace(
      /var\(\s*--collaboration-primary-(?:foreground|background),\s*(rgb\([^)]*\))\s*\)/g,
      "$1",
    );
  // Normalize RGB syntax for the shared jsdom parser.
  resolved = resolved.replace(
    /rgb\((\d+) (\d+) (\d+)(?:\s*\/\s*([\d.]+)(%)?)?\)/g,
    (
      _,
      red: string,
      green: string,
      blue: string,
      alpha: string,
      percent: string,
    ) =>
      alpha === undefined
        ? `rgb(${red}, ${green}, ${blue})`
        : `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / (percent ? 100 : 1)})`,
  );
  const style = document.createElement("style");
  style.textContent = resolved;
  document.head.append(style);
  return variables;
}

function rgb(triplet: string) {
  return `rgb(${triplet.split(" ").join(", ")})`;
}

describe("collaboration surface theme", () => {
  it.each(["light", "dark"] as const)(
    "keeps workspace and group surfaces readable in %s mode",
    (mode) => {
      const variables = installTheme(mode);
      document.body.innerHTML = `<div class="collaboration-platform-app">
        ${surfaces.map((classes) => `<section class="${classes}"></section>`).join("")}
        <form class="collaboration-resource-dialog collaboration-group-create-dialog">
          <footer class="collaboration-group-create-actions">
            <button class="collaboration-primary-button">Create</button>
            <button class="collaboration-secondary-button">Cancel</button>
          </footer>
        </form>
        <div class="collaboration-group-people-picker"></div>
        <span class="collaboration-run-status running">Running</span>
        <span class="collaboration-run-status succeeded">Succeeded</span>
        <span class="collaboration-run-status failed">Failed</span>
      </div>`;
      for (const classes of surfaces) {
        const surface = document.querySelector(`.${classes.split(" ")[0]}`)!;
        expect(getComputedStyle(surface).backgroundColor, classes).toBe(
          rgb(variables["--color-bg-base"]),
        );
      }
      const primary = document.querySelector<HTMLButtonElement>(
        ".collaboration-primary-button",
      )!;
      expect(getComputedStyle(primary).color).toBe(
        rgb(variables["--color-bg-base"]),
      );
      expect(getComputedStyle(primary).backgroundColor).toBe(
        rgb(variables["--color-text-primary"]),
      );
      primary.disabled = true;
      expect(getComputedStyle(primary).color).toBe(
        rgb(variables["--color-text-muted"]),
      );
      expect(getComputedStyle(primary).backgroundColor).toBe(
        rgb(variables["--color-bg-subtle"]),
      );
      const picker = document.querySelector(
        ".collaboration-group-people-picker",
      )!;
      expect(getComputedStyle(picker).backgroundColor).toBe(
        rgb(variables["--color-popover"]),
      );
      expect(getComputedStyle(picker).color).toBe(
        rgb(variables["--color-text-primary"]),
      );
      for (const [state, token] of [
        ["running", "--color-warning"],
        ["succeeded", "--color-success"],
        ["failed", "--color-destructive"],
      ] as const) {
        const status = document.querySelector(
          `.collaboration-run-status.${state}`,
        )!;
        expect(getComputedStyle(status).color).toBe(rgb(variables[token]));
        expect(getComputedStyle(status).backgroundColor).toBe(
          `rgba(${variables[token].split(" ").join(", ")}, 0.1)`,
        );
      }
    },
  );

  it("uses semantic colors throughout workspace chrome and status indicators", () => {
    for (const path of [
      "./platform.css",
      "./base.css",
      "../project-agent-config/ProjectAgentConfiguration.module.css",
    ]) {
      expect(source(path)).not.toMatch(
        /(?:color|background|border):[^;{}]*#[\da-f]+/i,
      );
    }
  });
});
