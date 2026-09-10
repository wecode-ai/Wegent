//go:build !windows

// SPDX-License-Identifier: Apache-2.0
package auth

import (
	"os"
	"path/filepath"
)

func syncWegentDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func replaceWegentReceipt(source, target string) error {
	if err := os.Rename(source, target); err != nil {
		return err
	}
	return syncWegentDirectory(filepath.Dir(target))
}
