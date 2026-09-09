// SPDX-License-Identifier: Apache-2.0
// Built inside the pinned upstream module; no upstream source patch is required.
package main

import (
	"context"
	"fmt"
	"os"

	pluginauth "github.com/DingTalk-Real-AI/dingtalk-workspace-cli/internal/wegentpluginauth"
)

func main() {
	provider := pluginauth.Provider{Export: export, Detach: detach, Allowed: allowed, Run: run, Refresh: refresh, Revoke: revoke}
	// The manifest must declare exclusive export. The host stages escrow before
	// detach and activates it only after the durable source receipt is confirmed.
	if err := pluginauth.Serve(context.Background(), "dingtalk", "oauth2", provider, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "plugin_auth_dws_failed")
		os.Exit(1)
	}
}
