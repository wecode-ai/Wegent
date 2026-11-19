#pragma once

// Called on the guest owner thread before starting any guest process.
int ww_runtime_clean_catalogs(void);
int ww_runtime_replace_executor_file(const char *source);
