import { describe, expect, it } from "vitest";
import { getDesktopModelSelectorVerticalLayout } from "./model-selector-layout";

describe("desktop model selector placement", () => {
  it("flips the expanded list below a trigger when the preferred side cannot fit", () => {
    const layout = getDesktopModelSelectorVerticalLayout(
      { top: 372.125, bottom: 416.125 },
      760,
      316,
      "above",
    );

    expect(layout.placement).toBe("below");
    expect(layout.top).toBe(424.125);
    expect(layout.bottom).toBeUndefined();
    expect(layout.maxHeight).toBe(319.875);
    expect(layout.top! + 316).toBeLessThanOrEqual(744);
  });

  it("keeps a smaller panel above the trigger with the same eight pixel gap", () => {
    const layout = getDesktopModelSelectorVerticalLayout(
      { top: 372.125, bottom: 416.125 },
      760,
      160,
      "above",
    );

    expect(layout.placement).toBe("above");
    expect(layout.bottom).toBe(395.875);
    expect(760 - layout.bottom!).toBe(364.125);
  });

  it("opens above a bottom-edge trigger even when below is preferred", () => {
    const layout = getDesktopModelSelectorVerticalLayout(
      { top: 680, bottom: 724 },
      760,
      316,
      "below",
    );

    expect(layout.placement).toBe("above");
    expect(layout.bottom).toBe(88);
    expect(layout.maxHeight).toBe(608);
  });

  it("limits scrolling to the larger side when neither side can fit", () => {
    const layout = getDesktopModelSelectorVerticalLayout(
      { top: 230, bottom: 274 },
      500,
      316,
      "above",
    );

    expect(layout.placement).toBe("below");
    expect(layout.top).toBe(282);
    expect(layout.maxHeight).toBe(202);
    expect(layout.top! + layout.maxHeight).toBe(484);
  });

  it("keeps the preferred side when both constrained sides have equal space", () => {
    const layout = getDesktopModelSelectorVerticalLayout(
      { top: 274, bottom: 318 },
      544,
      608,
      "above",
    );

    expect(layout.placement).toBe("above");
    expect(layout.bottom).toBe(278);
    expect(layout.maxHeight).toBe(202);
  });
});
