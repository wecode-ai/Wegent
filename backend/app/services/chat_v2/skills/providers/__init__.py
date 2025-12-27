# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Built-in skill tool providers.

This package previously contained hardcoded tool providers that were automatically
registered when the skills module was imported.

As of the skill decoupling refactor, providers are now dynamically loaded from
skill packages stored in the database. Each skill can bundle its own provider.py
file that will be loaded at runtime.

This package is kept for backward compatibility but no longer exports any providers.
"""

__all__: list[str] = []
