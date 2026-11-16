if $_isvoid($_exitcode)
  printf "[startup-gdb-host-exit] unavailable\n"
  info proc mappings
else
  printf "[startup-gdb-host-exit] %d\n", $_exitcode
end
