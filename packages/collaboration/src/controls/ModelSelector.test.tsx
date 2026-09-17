// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { CollaborationTheme } from "../theme";
import { ModelSelector } from "./ModelSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";

let container: HTMLDivElement;
let root: Root;
const translate = createCollaborationTranslator("zh-CN");

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!target) throw new Error(`Missing control ${id}`);
  return target;
}

describe("model controls without a desktop host", () => {
  it.each([false, true])(
    "keeps the scoped theme in the model portal (mobile=%s)",
    (mobile) => {
      const openSettings = vi.fn();
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile={mobile}
              models={[]}
              selectedModel={null}
              selectedModelOptions={{}}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={vi.fn()}
              onOpenModelSettings={openSettings}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>,
        ),
      );
      act(() => element("model-selector-button").click());
      const menu = element("model-selector-menu");
      const surface = menu.closest<HTMLElement>(".collaboration-theme")!;
      expect(surface).not.toBeNull();
      expect(container.contains(surface)).toBe(false);
      expect(surface.dataset.theme).toBe("dark");
      expect(surface.style.getPropertyValue("--color-bg-base")).toBe(
        "24 24 24",
      );
      expect(surface.style.display).not.toBe("contents");
      expect(menu.textContent).not.toContain("workbench.");
      act(() => element("model-selector-add-custom-model").click());
      expect(openSettings).toHaveBeenCalledOnce();
      expect(
        document.querySelector('[data-testid="model-selector-menu"]'),
      ).toBeNull();
    },
  );

  it("preserves the theme and deliberate permission confirmation across both portals", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <PermissionModeSelector
            translate={translate}
            value="read-only"
            onChange={onChange}
          />
        </CollaborationTheme>,
      ),
    );
    act(() => element("permission-mode-menu-button").click());
    expect(
      element("permission-mode-menu-button-menu").style.getPropertyValue(
        "--color-bg-base",
      ),
    ).toBe("24 24 24");
    act(() => element("permission-mode-full-access").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(element("full-access-confirm-overlay").dataset.theme).toBe("dark");
    act(() => element("full-access-confirm-submit").click());
    expect(onChange).toHaveBeenCalledWith("full-access");
  });
});
