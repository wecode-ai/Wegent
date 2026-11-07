---
sidebar_position: 29
---

# Wework named themes and acceptance

## Experience and ownership

Appearance settings store independent light and dark themes. System mode uses the appropriate choice.
The acceptance baseline is the installed ChatGPT Desktop 26.1029.70936 (24905): 29 names and 44 variants.
The acceptance inventory is independent of application data to detect omissions. Tokyo Night uses
`#1a1b26` for the background, `#a9b1d6` for text, and `#7aa2f7` for the accent.

Themes cover Wework-owned chrome, tabs, sidebars, every settings page, authentication, plugins,
applications, automations, interactions, projects, boards, Issues, project Agent editors, menus and
dialogs. Detached windows, quick windows, Process Explorer, and system drag surfaces also consume
the theme. Startup flow, startup colors, recovery and error documents follow upstream. Code, diffs, terminal ANSI colors,
Markdown, rich text, file viewer controls, and interactive visualizations use semantic colors.
The remote Wegent Agent content is excluded; its Wework chrome still follows the theme.
Images, document paper, explicitly formatted cells, video, brand icons, QR codes, and web content
retain their content colors.

Changing a theme preserves fonts, font sizes and background images. Schema 2 of `wework.appearance`
stores theme IDs and explicit overrides rather than resolved palettes. Legacy default palette snapshots
migrate to theme defaults while user color changes survive. The main window saves both native theme
snapshots for workbench and Process Explorer windows; startup animation does not consume named themes.
Auxiliary windows consume preferences without overwriting them. Shared collaboration Web defaults
remain independent of desktop theme selection.

## CI acceptance matrix

The existing Core desktop runner uses isolated real Electron, Executor, Core DSH, storage and PTYs.
Only model responses are simulated. Each checkpoint creates its own prerequisites; runner cleanup
removes isolated files and processes.

| Case                          | Preconditions and actions                                                                                    | Expected result and evidence                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `appearance-themes` inventory | Enumerate an independent list of 16 light and 28 dark options; select every option in the real UI            | All 29 names and 44 variants apply; individual screenshots, observed colors and JSON evidence                             |
| Persistence                   | Select Proof and Tokyo Night independently; reload the renderer and restart Electron                         | Both choices survive; Tokyo Night matches three reference colors; light mode restores Proof                               |
| Settings                      | Visit all 20 built-in and Git plugin settings routes in Tokyo Night                                          | Theme colors and readable titles, with a screenshot of each page                                                          |
| Workspaces and portals        | Visit plugin marketplace/management, applications, automations, interactions, task home and settings menu    | Shared palette across real surfaces, including empty/unavailable states and portal screenshots                            |
| `local-file-preview`          | Open, switch and edit real local files; open context menus and browser controls                              | Editor, tree and controls follow Tokyo Night; existing behavioral assertions and captures remain                          |
| `office-file-preview`         | Open real PPTX, DOCX and XLSX files; scroll, switch tasks and restore previews                               | Containers and controls follow Tokyo Night while original document colors remain; existing assertions and captures remain |
| `collaboration-first-use`     | Create a real local project and Issue and select its human owner                                             | Project, dialogs, Issue properties and rich text work in Tokyo Night; persistence checks and captures remain              |
| `background-terminals`        | Start real background tools, read output, change appearance and stop processes                               | Terminal and ANSI palette update; PTY lifecycle, scrolling and screenshot coverage remain                                 |
| `application-menu`            | Open Process Explorer through the native menu; switch the main window between Tokyo Night and Matrix         | The independent window updates without restarting; existing language, mode and window checks remain                       |
| `streaming-content`           | Write a real visualization through a tool, change calculator inputs, then switch between two dark themes     | The iframe URL, inputs and calculated result survive; sandbox isolation remains                                           |
| Unit and contract tests       | Catalogue, migration, invalid data, modes, storage, overrides/reset, Pierre code/ANSI/visualization and host | Normal, failure and recovery paths collected by existing renderer and host CI                                             |

Declarations live in `wework/e2e/desktop/catalog/`. Theme paths select the related content and window
regressions. Existing CI uploads screenshots and diagnostics from `wework/test-results/`; generated
logs and images are not committed. Appearance gallery captures survive reduced screenshot modes.

## Execution record

This task requires CI-only verification, with Git hooks as the only local exception. CI opens the
actual Electron interfaces and produces screenshots. Use the latest PR revision's CI results and
artifacts as evidence; authored coverage alone is not a passing result.
