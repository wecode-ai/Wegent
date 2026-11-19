// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "./ConfirmationDialog";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const labels = {
  cancel: "Cancel",
  confirm: "Delete",
  pending: "Deleting",
  failed: "Failed",
};
const button = (suffix: string) =>
  container.querySelector<HTMLButtonElement>(
    `[data-testid="confirm-${suffix}"]`,
  )!;
function dialog(
  onConfirm: () => Promise<void>,
  onClose: () => void,
  key = "a",
  confirmDisabled = false,
) {
  return createElement(ConfirmationDialog, {
    key,
    title: key,
    subject: key,
    description: "Delete?",
    labels,
    testIdPrefix: "confirm",
    confirmDisabled,
    onConfirm,
    onClose,
  });
}
it("retains confirmation intent while readiness is unavailable and keeps cancellation usable", async () => {
  const confirm = vi.fn(async () => {});
  const close = vi.fn();
  await act(async () => root.render(dialog(confirm, close, "a", true)));
  expect(button("confirm").disabled).toBe(true);
  expect(button("cancel").disabled).toBe(false);
  // Exercise the handler independently of the native disabled attribute.
  button("confirm").disabled = false;
  await act(async () => button("confirm").click());
  expect(confirm).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();

  await act(async () => root.render(dialog(confirm, close)));
  expect(button("confirm").disabled).toBe(false);
  await act(async () => button("confirm").click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();

  await act(async () => root.render(dialog(confirm, close, "b", true)));
  await act(async () => button("cancel").click());
  expect(close).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledOnce();
});

it("does not close a replacement dialog when an earlier deletion finishes", async () => {
  let done!: () => void;
  const closeA = vi.fn(),
    closeB = vi.fn();
  await act(async () =>
    root.render(
      dialog(
        () =>
          new Promise((resolve) => {
            done = resolve;
          }),
        closeA,
      ),
    ),
  );
  await act(async () => button("confirm").click());
  await act(async () => root.render(dialog(async () => {}, closeB, "b")));
  await act(async () => done());
  expect(closeA).not.toHaveBeenCalled();
  expect(closeB).not.toHaveBeenCalled();
  expect(
    container.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
  ).toBe("b");
});
it("retains keyboard focus while pending and restores an actionable control after failure", async () => {
  let fail!: (reason: Error) => void;
  const close = vi.fn();
  await act(async () =>
    root.render(
      dialog(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
        close,
      ),
    ),
  );
  button("confirm").focus();
  await act(async () => button("confirm").click());
  const popup = container.querySelector('[role="dialog"]')!;
  expect(document.activeElement).toBe(popup);
  expect(
    popup.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    ),
  ).toBe(false);
  popup.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () => fail(new Error("Retry deletion")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Retry deletion",
  );
  expect(document.activeElement).toBe(button("confirm"));
  expect(button("confirm").disabled).toBe(false);
});

it("isolates background controls and restores their state and focus after closing", async () => {
  const opener = document.createElement("button");
  opener.textContent = "Project navigation";
  document.body.append(opener);
  opener.focus();
  await act(async () => root.render(dialog(async () => {}, vi.fn())));
  expect(opener.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(button("cancel"));
  await act(async () => root.render(null));
  expect(opener.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
