export const knownProjectViews = [
  "board",
  "calendar",
  "gantt",
  "table",
  "milestones",
  "files",
  "manage",
] as const;

export type KnownProjectView = (typeof knownProjectViews)[number];
export type ProjectSurface = "work" | "plan" | "admin";
export type ProjectSurfaceMode =
  | "board"
  | "timeline"
  | "milestones"
  | "table"
  | "files"
  | "settings";
export type TimelineSubview = "calendar" | "gantt";
export interface ResolvedProjectSurface {
  surface: ProjectSurface;
  mode: ProjectSurfaceMode;
  legacyView: KnownProjectView;
  timelineSubview: TimelineSubview | null;
  lossy: boolean;
  unsupported: boolean;
}
export interface ProjectSurfaceFeatureFlags {
  "collab.projectSurfaces.v1"?: boolean;
}

export function isKnownProjectView(view: string): view is KnownProjectView {
  return knownProjectViews.some((candidate) => candidate === view);
}

function resolveKnownProjectView(
  view: KnownProjectView,
): ResolvedProjectSurface {
  const common = {
    legacyView: view,
    timelineSubview: null,
    lossy: false,
    unsupported: false,
  };
  switch (view) {
    case "board":
      return { ...common, surface: "work", mode: "board" };
    case "calendar":
    case "gantt":
      return {
        ...common,
        surface: "plan",
        mode: "timeline",
        timelineSubview: view,
      };
    case "table":
    case "milestones":
      return { ...common, surface: "plan", mode: view };
    case "files":
      return { ...common, surface: "admin", mode: "files" };
    case "manage":
      return { ...common, surface: "admin", mode: "settings" };
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

export function resolveProjectSurface(view: string): ResolvedProjectSurface {
  return isKnownProjectView(view)
    ? resolveKnownProjectView(view)
    : { ...resolveKnownProjectView("board"), lossy: true, unsupported: true };
}
