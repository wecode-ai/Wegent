#!/bin/sh
case "${0##*/}" in
  generic-action)
    printf x >> attempts
    printf '%s' '{"success":false,"error":{"code":"request_failed"}}'
    ;;
  auth-stderr)
    printf '%s' '{"success":false,"error":{"code":"need_login","message":"private-token"}}' >&2
    ;;
  unknown-action)
    printf x >> attempts
    printf '%s' 'private-unknown-error' >&2
    ;;
  *) exit 2 ;;
esac
exit 1
