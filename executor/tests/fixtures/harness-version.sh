#!/bin/sh

test "$#" -eq 1 && test "$1" = '--version' || exit 2
printf '  %s  \n\n%s\n' '2.1.228 (Claude Code)' 'ignored second line'
