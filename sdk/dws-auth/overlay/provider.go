// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/app"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/auth"
	pluginauth "github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/wegentpluginauth"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/pkg/config"
	"github.com/DingTalk-Real-AI/dingtalk-workspace-cli/pkg/edition"
)

var denied = errors.New("plugin_auth_dws_operation_denied")

func export(ctx context.Context) (pluginauth.Account, error) {
	// The connector targets the official MCP provider. A custom CLI environment
	// needs its own declaration; never move its grant to another token endpoint.
	if config.GetMCPBaseURL() != config.DefaultMCPBaseURL {
		return pluginauth.Account{}, denied
	}
	token, err := auth.LoadTokenData(config.DefaultConfigDir())
	if err != nil || token == nil || token.CorpID == "" || token.UserID == "" || token.Source != "mcp" || token.ClientID == "" || token.AccessToken == "" || token.RefreshToken == "" {
		return pluginauth.Account{}, denied
	}
	return encode(token)
}

func detach(ctx context.Context, migrationID string, credential pluginauth.Credential) error {
	token, err := decode(credential)
	if err != nil {
		return denied
	}
	err = auth.DetachWegentToken(ctx, config.DefaultConfigDir(), migrationID, token)
	if errors.Is(err, auth.ErrWegentSourceChanged) {
		return pluginauth.ErrSourceChanged
	}
	return err
}

func allowed(arguments []string) bool {
	if len(arguments) == 1 && arguments[0] == "account-status" {
		return true
	}
	if len(arguments) == 0 {
		return false
	}
	products := edition.Get().VisibleProducts
	if products == nil {
		return false
	}
	found := false
	for _, product := range products() {
		if arguments[0] == product {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	blocked := []string{"--token", "--client-id", "--client-secret", "--profile", "--debug", "--verbose", "-v", "--output", "-o", "--mock"}
	for _, argument := range arguments {
		name := strings.SplitN(argument, "=", 2)[0]
		if strings.HasPrefix(name, "-") && !strings.HasPrefix(name, "--") && len(name) > 2 && !strings.HasPrefix(name, "-f") && strings.ContainsAny(name[1:], "vo") {
			return false
		}
		for _, flag := range blocked {
			if name == flag || (len(flag) == 2 && strings.HasPrefix(name, flag)) {
				return false
			}
		}
	}
	return true
}

func decode(credential pluginauth.Credential) (*auth.TokenData, error) {
	value := make(map[string]any, len(credential))
	for key, item := range credential {
		value[key] = item
	}
	for _, key := range []string{"expires_at", "refresh_expires_at"} {
		if raw, ok := value[key]; ok {
			seconds, err := strconv.ParseFloat(fmt.Sprint(raw), 64)
			if err != nil || seconds <= 0 || seconds > 253402300799 {
				return nil, denied
			}
			value[key] = time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339)
		}
	}
	if private, ok := value["provider_private"].(map[string]any); ok {
		value["persistent_code"] = private["persistent_code"]
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, denied
	}
	var token auth.TokenData
	if json.Unmarshal(encoded, &token) != nil || token.AccessToken == "" || token.CorpID == "" || token.UserID == "" {
		return nil, denied
	}
	// The default DWS connector uses MCP-managed OAuth. Direct app credentials
	// require a separate provider declaration rather than reading a local secret.
	if token.Source != "mcp" || token.ClientID == "" {
		return nil, denied
	}
	return &token, nil
}

func encode(token *auth.TokenData) (pluginauth.Account, error) {
	data, err := json.Marshal(token)
	if err != nil {
		return pluginauth.Account{}, denied
	}
	var value pluginauth.Credential
	if json.Unmarshal(data, &value) != nil {
		return pluginauth.Account{}, denied
	}
	value["expires_at"] = token.ExpiresAt.Unix()
	value["refresh_expires_at"] = token.RefreshExpAt.Unix()
	value["provider_private"] = map[string]any{"persistent_code": token.PersistentCode}
	delete(value, "persistent_code")
	return pluginauth.Account{ID: token.CorpID + ":" + token.UserID, Credential: value}, nil
}

func withMemory(token *auth.TokenData, writable bool, callback func(string) error) error {
	directory, err := os.MkdirTemp("", "wegent-dws-native-")
	if err != nil {
		return denied
	}
	defer os.RemoveAll(directory)
	originalConfig, hadConfig := os.LookupEnv("DWS_CONFIG_DIR")
	if os.Setenv("DWS_CONFIG_DIR", directory) != nil {
		return denied
	}
	defer func() {
		if hadConfig {
			_ = os.Setenv("DWS_CONFIG_DIR", originalConfig)
		} else {
			_ = os.Unsetenv("DWS_CONFIG_DIR")
		}
	}()
	original := edition.Get()
	hooks := *original
	hooks.Name, hooks.IsEmbedded, hooks.HideAuthLogin = "wegent", true, true
	hooks.AutoPurgeToken = false
	hooks.ConfigDir = func() string { return directory }
	hooks.LoadToken = func(string) ([]byte, error) { return json.Marshal(token) }
	hooks.SaveToken = func(_ string, data []byte) error {
		if !writable {
			return denied
		}
		var next auth.TokenData
		if json.Unmarshal(data, &next) != nil || next.CorpID != token.CorpID || next.UserID != token.UserID {
			return denied
		}
		*token = next
		return nil
	}
	hooks.DeleteToken = func(string) error { return denied }
	hooks.OnAuthError = func(string, error) error { return denied }
	if !writable {
		hooks.TokenProvider = func(context.Context, func() (string, error)) (string, error) { return token.AccessToken, nil }
	}
	edition.Override(&hooks)
	defer edition.Override(original)
	return callback(directory)
}

func refresh(ctx context.Context, credential pluginauth.Credential) (pluginauth.Account, error) {
	token, err := decode(credential)
	if err != nil || token.RefreshToken == "" {
		return pluginauth.Account{}, denied
	}
	err = withMemory(token, true, func(directory string) error {
		provider := auth.NewOAuthProvider(directory, slog.New(slog.NewTextHandler(io.Discard, nil)))
		refreshed, err := provider.GetTokenSnapshot(ctx)
		if err != nil {
			return denied
		}
		*token = *refreshed
		return nil
	})
	if err != nil {
		return pluginauth.Account{}, denied
	}
	return encode(token)
}

func revoke(ctx context.Context, credential pluginauth.Credential) error {
	token, err := decode(credential)
	if err != nil {
		return err
	}
	return withMemory(token, false, func(string) error { return auth.RevokeTokenRemoteForData(ctx, token) })
}

func run(ctx context.Context, credential pluginauth.Credential, arguments []string) error {
	if !allowed(arguments) {
		return denied
	}
	if _, ok := credential["refresh_token"]; ok {
		return denied
	}
	if _, ok := credential["provider_private"]; ok {
		return denied
	}
	token, err := decode(credential)
	if err != nil {
		return err
	}
	// Execute the upstream CLI with the same business command implementation.
	if len(arguments) == 1 && arguments[0] == "account-status" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"authenticated": true, "accountId": token.CorpID + ":" + token.UserID})
	}
	// Its private auth store hooks never read/write the platform Keychain.
	return withMemory(token, false, func(string) error {
		output, err := capture(func() int {
			original := os.Args
			os.Args = append([]string{"dws"}, arguments...)
			defer func() { os.Args = original }()
			return app.Execute()
		})
		if err != nil || bytes.Contains(output, []byte(token.AccessToken)) {
			return denied
		}
		_, err = os.Stdout.Write(output)
		return err
	})
}

func capture(callback func() int) ([]byte, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, denied
	}
	defer reader.Close()
	original := os.Stdout
	os.Stdout = writer
	defer func() { os.Stdout = original; writer.Close() }()
	result := make(chan []byte, 1)
	go func() { data, _ := io.ReadAll(io.LimitReader(reader, 1024*1024+1)); result <- data; reader.Close() }()
	code := callback()
	writer.Close()
	output := <-result
	if code != 0 || len(output) > 1024*1024 {
		return nil, denied
	}
	return output, nil
}
