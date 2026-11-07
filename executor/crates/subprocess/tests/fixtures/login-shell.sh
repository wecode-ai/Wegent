#!/bin/sh
set -eu

printf '%s\n' "$1" > "${0%/*}/arguments"
printf 'startup noise'
printf '_WEGENT_SHELL_ENV_DELIMITER_PATH=/Users/test/.npm-global/bin:/usr/bin\nCUSTOM_ENV=loaded\n_WEGENT_SHELL_ENV_DELIMITER_'
