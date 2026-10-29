// Short-lived readiness probes must not reset the display while Openbox connects.
// xvfb-run owns the isolated server and terminates it when the checkpoint exits.
export const ISOLATED_XVFB_OPTIONS = [
  '-a',
  '--error-file=/dev/stderr',
  '--server-args=-noreset -screen 0 1280x720x24',
]
