#!/usr/bin/env bash

wework_decode_release_notes() {
  local notes="${1-}"
  printf '%s' "${notes//\\n/$'\n'}"
}
