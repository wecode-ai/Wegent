import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/resolver-matrix.json";
import boundary from "./__fixtures__/resolver-boundary-matrix.json";
import { knownProjectViews, resolveProjectSurface } from "./projectSurfaces";
import {
  parseProjectSurfaceQuery,
  projectViewFromQuery,
} from "./projectSurfaceRouting";

describe("project surface routing", () => {
  for (const test of golden.cases) {
    it(test.id, () => {
      const input = test.input;
      const actual =
        input.kind === "legacy"
          ? resolveProjectSurface(input.view!)
          : parseProjectSurfaceQuery(input.query!);
      expect(actual).toEqual(test.expected);
    });
  }
  for (const test of boundary.cases) {
    it(test.id, () =>
      expect(parseProjectSurfaceQuery(test.query)).toEqual(test.expected),
    );
  }
  it("preserves every legacy URL with the flag disabled and never reads surface parameters", () => {
    for (const view of knownProjectViews) {
      const query = {
        get(key: string) {
          expect(key).toBe("view");
          return view;
        },
      };
      expect(projectViewFromQuery(query)).toBe(view);
      expect(
        projectViewFromQuery(query, { "collab.projectSurfaces.v1": false }),
      ).toBe(view);
    }
  });
  it("uses new queries only when enabled, without mutating them", () => {
    const query = new URLSearchParams("surface=admin&mode=settings");
    expect(projectViewFromQuery(query)).toBe("board");
    expect(
      projectViewFromQuery(query, { "collab.projectSurfaces.v1": true }),
    ).toBe("manage");
    expect(query.toString()).toBe("surface=admin&mode=settings");
  });
});
