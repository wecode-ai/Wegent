// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { CollaborationTheme } from "../theme";
import { ModelSelector } from "./ModelSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";
import type { UnifiedModel } from "@wegent/chat-core/models";

let container: HTMLDivElement;
let root: Root;
const translate = createCollaborationTranslator("zh-CN");

const cloudDeepseekModel: UnifiedModel = {
  name: 'deepseek-flash-responses(公网)',
  type: 'public',
  displayName: '公网:DeepSeek-V4-Flash',
  modelId: 'deepseek-flash',
  config: { protocol: 'openai-responses' },
}

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

  it.each(['deepseek', 'gpt', 'model-interface'])(
    'exposes catalog reasoning levels for a cloud model in the %s family',
    family => {
      const model = {
        ...cloudDeepseekModel,
        config: { ...cloudDeepseekModel.config, ui: { family } },
      }
      const onSelectModelOption = vi.fn()
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile
              models={[model]}
              selectedModel={model}
              selectedModelOptions={{ reasoning: 'high' }}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={onSelectModelOption}
              onOpenModelSettings={vi.fn()}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>
        )
      )

      act(() => element('model-selector-button').click())
      // element() throws when a control is missing.
      const optionLabels = ['low', 'high', 'max'].map(value =>
        element(`model-control-reasoning-${value}`).textContent?.trim()
      )
      expect(optionLabels.every(Boolean)).toBe(true)
      expect(document.querySelector('[data-testid="model-control-reasoning-medium"]')).toBeNull()
      expect(document.querySelector('[data-testid="model-control-reasoning-xhigh"]')).toBeNull()
      act(() => element('model-control-reasoning-max').click())

      expect(onSelectModelOption).toHaveBeenCalledWith('reasoning', 'max')
    }
  )

  it.each(['deepseek', 'gpt', 'model-interface'])(
    'enables the reasoning row for a cloud catalog model in the %s family on desktop',
    family => {
      const model = {
        ...cloudDeepseekModel,
        config: { ...cloudDeepseekModel.config, ui: { family } },
      }
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile={false}
              models={[model]}
              selectedModel={model}
              selectedModelOptions={{ reasoning: 'high' }}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={vi.fn()}
              onOpenModelSettings={vi.fn()}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>
        )
      )

      act(() => element('model-selector-button').click())

      const reasoningRow = element('model-control-menu-reasoning') as HTMLButtonElement
      expect(reasoningRow.disabled).toBe(false)
      expect(reasoningRow.textContent).toContain(
        translate('workbench.local_model_reasoning_high', 'High')
      )
    }
  )
})
