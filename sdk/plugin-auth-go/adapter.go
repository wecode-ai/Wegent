// SPDX-License-Identifier: Apache-2.0
package pluginauth

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

var ErrProvider = errors.New("plugin_auth_provider_failed")
var ErrUnsupported = errors.New("plugin_auth_operation_unsupported")

// ErrSourceChanged is valid only after Detach durably prevents this transfer ID
// from deleting source credentials. It authorizes clearing the obsolete escrow.
var ErrSourceChanged = errors.New("plugin_auth_source_changed")

type Account struct {
	ID         string
	Credential Credential
}

// Provider callbacks own provider semantics; transport and secret error handling are shared.
type Provider struct {
	Export    func(context.Context) (Account, error)
	Authorize func(context.Context) (Account, error)
	Refresh   func(context.Context, Credential) (Account, error)
	Revoke    func(context.Context, Credential) error
	Detach    func(context.Context, string, Credential) error
	Allowed   func([]string) bool
	Run       func(context.Context, Credential, []string) error
}

func validate(value Credential, kind string) error {
	fields := map[string][]string{"password": {"username", "password"}, "bearer": {"token"}, "oauth2": {"access_token"}}
	required, ok := fields[kind]
	if !ok || value == nil {
		return ErrProtocol
	}
	for _, key := range required {
		text, ok := value[key].(string)
		if !ok || strings.TrimSpace(text) == "" {
			return ErrProtocol
		}
	}
	return nil
}

// Serve runs once per native process. It is intentionally not goroutine-safe:
// auth callback stdout/stderr are redirected process-wide, just as in the Python SDK.
func Serve(ctx context.Context, connector, kind string, provider Provider, arguments []string) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrProvider
		}
	}()
	if len(arguments) == 0 {
		return ErrUnsupported
	}
	operation := arguments[0]
	switch operation {
	case "export":
		if provider.Export == nil || len(arguments) != 1 {
			return ErrUnsupported
		}
	case "authorize":
		if kind != "oauth2" || provider.Authorize == nil || len(arguments) != 1 {
			return ErrUnsupported
		}
	case "refresh":
		if kind != "oauth2" || provider.Refresh == nil || len(arguments) != 1 {
			return ErrUnsupported
		}
	case "revoke":
		if kind != "oauth2" || provider.Revoke == nil || len(arguments) != 1 {
			return ErrUnsupported
		}
	case "detach":
		if kind != "oauth2" || provider.Detach == nil || len(arguments) != 2 || len(arguments[1]) != 64 || strings.Trim(arguments[1], "0123456789abcdef") != "" {
			return ErrUnsupported
		}
	case "run":
		if provider.Run == nil || provider.Allowed == nil || !provider.Allowed(arguments[1:]) {
			return ErrUnsupported
		}
	default:
		return ErrUnsupported
	}
	channel, err := Connect(connector, kind)
	if err != nil {
		return err
	}
	defer channel.Close()
	var credential Credential
	if operation == "run" || operation == "refresh" || operation == "revoke" || operation == "detach" {
		credential, err = channel.Receive()
		if err != nil {
			return err
		}
	}
	if operation == "run" {
		channel.Close()
		if provider.Run(ctx, credential, arguments[1:]) != nil {
			return ErrProvider
		}
		return nil
	}
	var account Account
	err = quiet(func() error {
		switch operation {
		case "export":
			account, err = provider.Export(ctx)
		case "authorize":
			account, err = provider.Authorize(ctx)
		case "refresh":
			account, err = provider.Refresh(ctx, credential)
		case "revoke":
			err = provider.Revoke(ctx, credential)
		case "detach":
			err = provider.Detach(ctx, arguments[1], credential)
		}
		return err
	})
	if err != nil {
		if operation == "detach" && errors.Is(err, ErrSourceChanged) {
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "source_changed", "protocolVersion": 1})
		}
		return ErrProvider
	}
	if operation == "revoke" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "ok", "protocolVersion": 1})
	}
	if operation == "detach" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "detached", "protocolVersion": 1})
	}
	if strings.TrimSpace(account.ID) == "" || len(account.ID) > 256 {
		return ErrProvider
	}
	if err := channel.Send(account.Credential); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "ok", "protocolVersion": 1, "credentialType": kind, "accountId": account.ID})
}

func quiet(callback func() error) error {
	sink, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return ErrProvider
	}
	stdout, stderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = sink, sink
	defer func() { os.Stdout, os.Stderr = stdout, stderr; sink.Close() }()
	return callback()
}
