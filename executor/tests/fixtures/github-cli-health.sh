#!/bin/sh
if [ "$1" = '--version' ]; then printf 'gh fixture\n'; exit 0; fi
# Any old all-host auth status probe returns the opposite result on purpose.
if [ "$1 $2" = 'auth status' ]; then exit 0; fi
if [ "$*" != 'api user --silent --hostname github.com' ]; then exit 99; fi
if [ -f "$GH_CONFIG_DIR/ready" ]; then exit 0; fi
case "$GH_CONFIG_DIR" in
  */ready) exit 0 ;;
  */forbidden) printf 'HTTP 403 SECRET' >&2; exit 1 ;;
  */network) printf 'connection timeout SECRET' >&2; exit 1 ;;
  */unavailable) printf 'gh: command not found' >&2; exit 127 ;;
  *) exit 4 ;;
esac
