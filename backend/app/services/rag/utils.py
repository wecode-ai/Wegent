# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
RAG utility functions.
"""


def get_index_name(dataset_id: int, step: int = 5000) -> str:
    """
    Calculate the index name based on dataset_id.

    Args:
        dataset_id: The dataset ID
        step: The index step size (default: 5000)

    Returns:
        Index name, e.g., 'wegent_dataset_1-5000'

    Examples:
        >>> get_index_name(1)
        'wegent_dataset_1-5000'
        >>> get_index_name(5001)
        'wegent_dataset_5001-10000'
    """
    start_id = ((dataset_id - 1) // step) * step + 1
    end_id = start_id + step - 1
    return f"wegent_dataset_{start_id}-{end_id}"