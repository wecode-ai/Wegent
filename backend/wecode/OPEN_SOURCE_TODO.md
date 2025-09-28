# Open Source Migration Guide

## Overview
This document records the tasks required to migrate from the internal version to the open source version.

## Changes:
### 1. Modify app/api/api.py file
```python
# Remove the following line
import wecode.api
```

### 2. Delete the wecode directory
```bash
rm -rf wecode/
```