// Synthetic fixture using the pinned upstream's real encrypted auth store.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/auth"
)

func main() {
	if len(os.Args) != 2 || runtime.GOOS == "windows" || os.Getenv("DWS_DISABLE_KEYCHAIN") != "1" {
		panic("fixture requires isolated file-backed authentication")
	}
	directory, storage := os.Getenv("DWS_CONFIG_DIR"), os.Getenv("DWS_KEYCHAIN_DIR")
	if !filepath.IsAbs(directory) || !filepath.IsAbs(storage) || filepath.Dir(directory) != filepath.Dir(storage) {
		panic("fixture requires adjacent isolated directories")
	}
	var err error
	switch os.Args[1] {
	case "seed":
		err = seed(directory)
	case "check":
		err = check(directory)
	default:
		err = fmt.Errorf("unsupported fixture action")
	}
	if err != nil {
		// Do not print upstream error bodies or credential values.
		fmt.Fprintln(os.Stderr, "DWS source-store fixture failed")
		os.Exit(1)
	}
	fmt.Println(`{"verified":true}`)
}

func seed(directory string) error {
	for _, user := range []string{"other-user", "synthetic-user"} {
		token := &auth.TokenData{
			CorpID: "synthetic-corp", UserID: user, ClientID: "synthetic-client", Source: "mcp",
			AccessToken:  "synthetic-desktop-dws-access-" + user,
			RefreshToken: "synthetic-desktop-dws-refresh-" + user,
			ExpiresAt:    time.Now().Add(time.Hour), RefreshExpAt: time.Now().Add(24 * time.Hour),
		}
		if err := auth.SaveTokenData(directory, token); err != nil {
			return err
		}
	}
	if _, err := auth.SetCurrentProfile(directory, "synthetic-corp:synthetic-user"); err != nil {
		return err
	}
	current, err := auth.LoadTokenData(directory)
	if err != nil || current == nil || current.UserID != "synthetic-user" {
		return fmt.Errorf("source selection was not persisted")
	}
	return nil
}

func check(directory string) error {
	removed, err := auth.LoadTokenDataForProfile(directory, "synthetic-corp:synthetic-user")
	if err == nil || removed != nil {
		return fmt.Errorf("source grant remains accessible")
	}
	other, err := auth.LoadTokenDataForProfile(directory, "synthetic-corp:other-user")
	if err != nil || other == nil || other.RefreshToken != "synthetic-desktop-dws-refresh-other-user" {
		return fmt.Errorf("unrelated source account was changed")
	}
	receipts, err := filepath.Glob(filepath.Join(directory, "wegent-transfers", "*.json"))
	if err != nil || len(receipts) != 1 {
		return fmt.Errorf("missing source handoff receipt")
	}
	data, err := os.ReadFile(receipts[0])
	if err != nil || strings.Contains(string(data), "synthetic-") {
		return fmt.Errorf("invalid public receipt")
	}
	var receipt struct {
		State string `json:"state"`
	}
	if json.Unmarshal(data, &receipt) != nil || receipt.State != "detached" {
		return fmt.Errorf("source handoff did not commit")
	}
	return nil
}
