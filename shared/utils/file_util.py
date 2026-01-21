# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import shutil

from shared.logger import setup_logger

logger = setup_logger(__name__)


def copy_file_to_dir(src_file, dst_dir):
    # Ensure target directory exists, create if it doesn't
    os.makedirs(dst_dir, exist_ok=True)

    # Get target file path
    dst_file = os.path.join(dst_dir, os.path.basename(src_file))

    # Copy file
    shutil.copy2(src_file, dst_file)
    logger.info(f"File {src_file} copied to {dst_file}")
