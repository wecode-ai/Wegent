#!/bin/sh
set -eu

test "$1 $2 $3" = 'debug models --bundled' || exit 2
test "$CODEX_HOME" = "$(dirname "$0")" || exit 3
case "$(cat "$CODEX_HOME/catalog-fixture-mode")" in
  success)
    printf '%s' '{"models":[{"slug":"gpt-6.1-sol","context_window":400000,"native_field":{"enabled":true}},{"slug":"gpt-5.6-sol","context_window":500000}]}'
    ;;
  exit) exit 7 ;;
  invalid-json) printf '%s' 'invalid-json' ;;
  missing-models) printf '%s' '{}' ;;
  *) exit 4 ;;
esac
