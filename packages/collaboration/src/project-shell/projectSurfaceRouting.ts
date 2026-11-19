import {
  isKnownProjectView,
  resolveProjectSurface,
  type ProjectSurfaceFeatureFlags,
  type ResolvedProjectSurface,
} from "./projectSurfaces";

export function parseProjectSurfaceQuery(
  query: string | Pick<URLSearchParams, "get">,
): ResolvedProjectSurface {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const view = params.get("view");
  if (view !== null && isKnownProjectView(view))
    return resolveProjectSurface(view);
  const surface = params.get("surface");
  const mode = params.get("mode");
  if (surface === "work" && (mode === null || mode === "board"))
    return resolveProjectSurface("board");
  if (surface === "admin") {
    if (mode === null || mode === "files")
      return resolveProjectSurface("files");
    if (mode === "settings") return resolveProjectSurface("manage");
  }
  if (surface === "plan") {
    if (mode === null || mode === "timeline")
      return { ...resolveProjectSurface("calendar"), lossy: true };
    if (mode === "table" || mode === "milestones")
      return resolveProjectSurface(mode);
  }
  return view === null && surface === null && mode === null
    ? resolveProjectSurface("board")
    : resolveProjectSurface("");
}

/** Keep the legacy render path untouched while the feature is disabled. */
export function projectViewFromQuery(
  query: Pick<URLSearchParams, "get">,
  flags?: ProjectSurfaceFeatureFlags,
): string {
  return flags?.["collab.projectSurfaces.v1"]
    ? parseProjectSurfaceQuery(query).legacyView
    : query.get("view") || "board";
}
