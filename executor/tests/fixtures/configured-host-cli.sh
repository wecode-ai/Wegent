#!/bin/sh
case "$*" in
  'auth status --json hosts --jq .hosts | keys')
    printf '%s\n' "$*" >> "$FIXTURE_HOST_LOG"
    printf '%s\n' '["ghe.company.test"]'
    ;;
  'config get host --global')
    printf '%s\n' 'http://gitlab.company.test:8080'
    ;;
  *) exit 1 ;;
esac
