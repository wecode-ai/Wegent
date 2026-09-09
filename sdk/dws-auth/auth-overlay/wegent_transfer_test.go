// SPDX-License-Identifier: Apache-2.0
package auth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/keychain"
)

func wegentTransferFixture(t *testing.T) (string, *TokenData) {
	t.Helper()
	// Upstream's isolated test store: never touch the developer's OS Keychain.
	t.Setenv(keychain.DisableKeychainEnv, "1")
	cleanupKeychain(t)
	directory := t.TempDir()
	token := &TokenData{CorpID: "synthetic-corp", UserID: "alice", ClientID: "synthetic-client", Source: "mcp",
		AccessToken: "synthetic-access", RefreshToken: "synthetic-refresh", PersistentCode: "synthetic-persistent",
		ExpiresAt: time.Now().Add(time.Hour), RefreshExpAt: time.Now().Add(24 * time.Hour)}
	if err := SaveTokenData(directory, token); err != nil {
		t.Fatal(err)
	}
	return directory, token
}

func TestWegentTransferDetachesOnlySelectedAccountAndIsIdempotent(t *testing.T) {
	directory, token := wegentTransferFixture(t)
	other := *token
	other.UserID, other.AccessToken, other.RefreshToken = "bob", "synthetic-other-access", "synthetic-other-refresh"
	if err := SaveTokenData(directory, &other); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 64)
	if err := DetachWegentToken(context.Background(), directory, id, token); err != nil {
		t.Fatal(err)
	}
	if !wegentGrantAbsent(token) {
		t.Fatal("source still owns refresh grant")
	}
	if err := DetachWegentToken(context.Background(), directory, id, token); err != nil {
		t.Fatal("lost acknowledgement cannot resume")
	}
	remaining, err := LoadTokenDataForProfile(directory, "synthetic-corp:bob")
	if err != nil || remaining.RefreshToken != other.RefreshToken {
		t.Fatal("unrelated account changed")
	}
	data, err := os.ReadFile(filepath.Join(directory, "wegent-transfers", id+".json"))
	if err != nil || strings.Contains(string(data), "synthetic-") {
		t.Fatal("receipt exposes credential or identity")
	}
}

func TestWegentTransferRejectsGrantRotatedAfterExport(t *testing.T) {
	directory, token := wegentTransferFixture(t)
	rotated := *token
	rotated.RefreshToken = "synthetic-rotated"
	if err := SaveTokenData(directory, &rotated); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 64)
	if !errors.Is(DetachWegentToken(context.Background(), directory, id, token), ErrWegentSourceChanged) {
		t.Fatal("stale export detached a new grant")
	}
	current, err := LoadTokenData(directory)
	if err != nil || current.RefreshToken != rotated.RefreshToken {
		t.Fatal("new source grant changed")
	}
	if !errors.Is(DetachWegentToken(context.Background(), directory, id, token), ErrWegentSourceChanged) {
		t.Fatal("old transfer ID is not fenced")
	}
	if err := DetachWegentToken(context.Background(), directory, strings.Repeat("b", 64), &rotated); err != nil {
		t.Fatal("fresh transfer cannot use the rotated source")
	}
}

func TestWegentTransferFencesPreparedReceiptAfterRefresh(t *testing.T) {
	directory, token := wegentTransferFixture(t)
	id := strings.Repeat("c", 64)
	path, err := wegentReceiptPath(directory, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeWegentReceipt(path, &wegentReceipt{1, wegentFingerprint(token), "prepared"}); err != nil {
		t.Fatal(err)
	}
	rotated := *token
	rotated.RefreshToken = "synthetic-rotated"
	if err := SaveTokenData(directory, &rotated); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(DetachWegentToken(context.Background(), directory, id, token), ErrWegentSourceChanged) {
		t.Fatal("prepared receipt was not fenced")
	}
	// Even restoring the old source cannot make a delayed detach valid again.
	if err := SaveTokenData(directory, token); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(DetachWegentToken(context.Background(), directory, id, token), ErrWegentSourceChanged) {
		t.Fatal("obsolete transfer resumed")
	}
	current, err := LoadTokenData(directory)
	if err != nil || current.RefreshToken != token.RefreshToken {
		t.Fatal("fenced transfer changed source")
	}
}

func TestWegentTransferResumesAfterDeletionBeforeReceiptCommit(t *testing.T) {
	directory, token := wegentTransferFixture(t)
	id := strings.Repeat("b", 64)
	path, err := wegentReceiptPath(directory, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeWegentReceipt(path, &wegentReceipt{1, wegentFingerprint(token), "prepared"}); err != nil {
		t.Fatal(err)
	}
	if err := DeleteTokenDataForProfile(directory, "synthetic-corp:alice"); err != nil {
		t.Fatal(err)
	}
	if err := DetachWegentToken(context.Background(), directory, id, token); err != nil {
		t.Fatal("interrupted detach cannot recover")
	}
	receipt, err := readWegentReceipt(path)
	if err != nil || receipt.State != "detached" {
		t.Fatal("missing durable receipt")
	}
}

func TestWegentTransferRejectsMismatchedOrCorruptReceipt(t *testing.T) {
	directory, token := wegentTransferFixture(t)
	id := strings.Repeat("c", 64)
	path, err := wegentReceiptPath(directory, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"fingerprint":"wrong","state":"detached"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if DetachWegentToken(context.Background(), directory, id, token) == nil {
		t.Fatal("accepted unrelated receipt")
	}
	if wegentGrantAbsent(token) {
		t.Fatal("rejected receipt still deleted source")
	}
	if err := os.WriteFile(path, []byte(`not json`), 0600); err != nil {
		t.Fatal(err)
	}
	if DetachWegentToken(context.Background(), directory, id, token) == nil {
		t.Fatal("accepted corrupt receipt")
	}
}

func TestWegentTransferRequiresExistingSourceForNewReceipt(t *testing.T) {
	directory, token := wegentTransferFixture(t)
	if err := DeleteTokenDataForProfile(directory, "synthetic-corp:alice"); err != nil {
		t.Fatal(err)
	}
	if DetachWegentToken(context.Background(), directory, strings.Repeat("d", 64), token) == nil {
		t.Fatal("accepted unproven source handoff")
	}
}
