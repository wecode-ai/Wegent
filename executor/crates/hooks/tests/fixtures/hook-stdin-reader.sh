#!/bin/sh
input=$(cat)
printf '{"received":%s}' "$input"
