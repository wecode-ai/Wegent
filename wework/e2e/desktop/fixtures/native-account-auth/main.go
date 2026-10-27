// Exercise a non-Python provider through the production SDK and native broker.
package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	pluginauth "github.com/wegent/plugin-auth-go"
)

func main() {
	home := os.Getenv("HOME")
	if !filepath.IsAbs(home) {
		os.Exit(1)
	}
	provider := pluginauth.Provider{
		Export: func(context.Context) (pluginauth.Account, error) {
			data, err := os.ReadFile(filepath.Join(home, "native-account-source.json"))
			if err != nil {
				return pluginauth.Account{}, err
			}
			var credential pluginauth.Credential
			if err := json.Unmarshal(data, &credential); err != nil {
				return pluginauth.Account{}, err
			}
			return pluginauth.Account{ID: "native@example.test", Credential: credential}, nil
		},
		Revoke: func(_ context.Context, credential pluginauth.Credential) error {
			if credential["account"] != "native@example.test" {
				return pluginauth.ErrProvider
			}
			return os.WriteFile(filepath.Join(home, "native-account-revoked"), []byte("revoked"), 0600)
		},
	}
	if pluginauth.Serve(context.Background(), "native", "oauth2", provider, os.Args[1:]) != nil {
		os.Exit(1)
	}
}
