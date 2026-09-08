// SPDX-License-Identifier: Apache-2.0
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

var errWegentTransfer = errors.New("plugin_auth_dws_transfer_failed")

// ErrWegentSourceChanged confirms the old transfer ID is durably fenced off.
var ErrWegentSourceChanged = errors.New("plugin_auth_source_changed")

type wegentReceipt struct {
	Version     int    `json:"version"`
	Fingerprint string `json:"fingerprint"`
	State       string `json:"state"`
}

// DetachWegentToken is called only after the native host durably stages encrypted
// escrow. It uses the same lock and exact-profile deletion as upstream refresh.
// Receipts contain no tokens. They let a restarted host confirm a deletion whose
// acknowledgement was lost without deleting a different account or grant.
func DetachWegentToken(ctx context.Context, directory, migrationID string, expected *TokenData) error {
	if len(migrationID) != 64 || strings.Trim(migrationID, "0123456789abcdef") != "" || expected == nil || expected.CorpID == "" || expected.UserID == "" || expected.Source != "mcp" || expected.RefreshToken == "" {
		return errWegentTransfer
	}
	lock, err := AcquireDualLock(ctx, directory)
	if err != nil {
		return errWegentTransfer
	}
	defer lock.Release()
	return detachWegentTokenLocked(directory, migrationID, expected)
}

func detachWegentTokenLocked(directory, migrationID string, expected *TokenData) error {
	fingerprint := wegentFingerprint(expected)
	receiptPath, err := wegentReceiptPath(directory, migrationID)
	if err != nil {
		return errWegentTransfer
	}
	receipt, err := readWegentReceipt(receiptPath)
	if err != nil {
		return errWegentTransfer
	}
	if receipt != nil && (receipt.Version != 1 || receipt.Fingerprint != fingerprint || (receipt.State != "prepared" && receipt.State != "detached" && receipt.State != "aborted")) {
		return errWegentTransfer
	}
	if receipt != nil && receipt.State == "aborted" {
		return ErrWegentSourceChanged
	}
	selector := ProfileSelector(Profile{CorpID: expected.CorpID, UserID: expected.UserID})
	current, loadErr := loadTokenDataForProfileLocked(directory, selector)
	if (receipt == nil || receipt.State == "prepared") && loadErr == nil && current != nil && current.CorpID == expected.CorpID && current.UserID == expected.UserID && wegentFingerprint(current) != fingerprint {
		// Persist under the refresh lock before allowing escrow cancellation. A
		// concurrent or delayed detach with this ID can never delete a later grant.
		if writeWegentReceipt(receiptPath, &wegentReceipt{1, fingerprint, "aborted"}) != nil {
			return errWegentTransfer
		}
		return ErrWegentSourceChanged
	}
	if receipt == nil {
		if loadErr != nil || current == nil || wegentFingerprint(current) != fingerprint {
			return errWegentTransfer
		}
		receipt = &wegentReceipt{Version: 1, Fingerprint: fingerprint, State: "prepared"}
		if writeWegentReceipt(receiptPath, receipt) != nil {
			return errWegentTransfer
		}
	}
	if current != nil && loadErr == nil {
		if receipt.State == "detached" || wegentFingerprint(current) != fingerprint {
			return errWegentTransfer
		}
		if deleteTokenDataForProfileLocked(directory, selector) != nil {
			return errWegentTransfer
		}
	} else if loadErr != nil && !errors.Is(loadErr, ErrTokenDataNotFound) && !isWegentProfileMissing(directory, selector) {
		return errWegentTransfer
	}
	if !wegentGrantAbsent(expected) {
		return errWegentTransfer
	}
	receipt.State = "detached"
	if writeWegentReceipt(receiptPath, receipt) != nil {
		return errWegentTransfer
	}
	return nil
}

func isWegentProfileMissing(directory, selector string) bool {
	cfg, err := tokenLoadProfiles(directory)
	if err != nil || cfg == nil {
		return false
	}
	for _, profile := range cfg.Profiles {
		if ProfileSelector(profile) == selector {
			return false
		}
	}
	return true
}

func wegentGrantAbsent(expected *TokenData) bool {
	loaders := []func() (*TokenData, error){
		func() (*TokenData, error) { return tokenLoadKeychainIdentity(expected.CorpID, expected.UserID) },
		func() (*TokenData, error) { return tokenLoadKeychainForCorpID(expected.CorpID) },
		tokenLoadKeychain,
	}
	for _, load := range loaders {
		token, err := load()
		if err != nil && !errors.Is(err, ErrTokenDataNotFound) {
			return false
		}
		if token != nil && token.CorpID == expected.CorpID && token.UserID == expected.UserID && (token.RefreshToken == expected.RefreshToken || token.AccessToken == expected.AccessToken) {
			return false
		}
	}
	return true
}

func wegentFingerprint(token *TokenData) string {
	// Expiration timestamps may lose subsecond precision in the common protocol;
	// compare identity and all grant-bearing fields, not display metadata.
	data, _ := json.Marshal([]string{token.CorpID, token.UserID, token.Source, token.ClientID, token.AccessToken, token.RefreshToken, token.PersistentCode})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func wegentReceiptPath(directory, migrationID string) (string, error) {
	folder := filepath.Join(directory, "wegent-transfers")
	if err := os.Mkdir(folder, 0700); err != nil && !os.IsExist(err) {
		return "", err
	}
	info, err := os.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errWegentTransfer
	}
	if syncWegentDirectory(directory) != nil {
		return "", errWegentTransfer
	}
	return filepath.Join(folder, migrationID+".json"), nil
}

func readWegentReceipt(path string) (*wegentReceipt, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return nil, errWegentTransfer
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errWegentTransfer
	}
	var receipt wegentReceipt
	if json.Unmarshal(data, &receipt) != nil {
		return nil, errWegentTransfer
	}
	return &receipt, nil
}

func writeWegentReceipt(path string, receipt *wegentReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return errWegentTransfer
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".transfer-*")
	if err != nil {
		return errWegentTransfer
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return errWegentTransfer
	}
	if file.Sync() != nil || file.Close() != nil {
		return errWegentTransfer
	}
	return replaceWegentReceipt(file.Name(), path)
}
