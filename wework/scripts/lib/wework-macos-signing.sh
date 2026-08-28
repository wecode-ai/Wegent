#!/usr/bin/env bash

wework_normalize_macos_signing_identity() {
  local identity="$1"
  identity="${identity#Developer ID Application: }"
  identity="${identity#\"}"
  identity="${identity%\"}"
  printf '%s\n' "$identity"
}
