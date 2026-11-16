if $_isvoid($_exitcode)
  printf "[startup-gdb-host-exit] unavailable\n"
else
  printf "[startup-gdb-host-exit] %d\n", $_exitcode
end
