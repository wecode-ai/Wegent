// SPDX-License-Identifier: Apache-2.0
package pluginauth

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestStrictJSONRejectsConfusedFrames(t *testing.T) {
	for _, input := range []string{`{"a":1,"a":2}`, `{"a":{"b":1,"b":2}}`, `{"a":NaN}`, `{} {}`, `{"a":[1,]}`, `{"a":1e999}`, string([]byte{'"', 255, '"'})} {
		if _, err := strictJSON([]byte(input)); err == nil {
			t.Fatal("accepted invalid JSON")
		}
	}
}

func TestFrameRejectsWrongIdentityAndOversize(t *testing.T) {
	for _, body := range []string{
		`{"protocolVersion":true,"connectorSlug":"test","credentialType":"oauth2","credential":{"access_token":"s"}}`,
		`{"protocolVersion":1,"connectorSlug":"other","credentialType":"oauth2","credential":{"access_token":"s"}}`,
		`{"protocolVersion":1,"connectorSlug":"test","credentialType":"oauth2","credential":{"access_token":""}}`,
		strings.Repeat("x", MaxFrameBytes+1),
	} {
		left, right := net.Pipe()
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer right.Close()
			binary.Write(right, binary.BigEndian, uint32(len(body)))
			right.Write([]byte(body))
		}()
		channel := Channel{left, "test", "oauth2"}
		if _, err := channel.Receive(); err == nil {
			t.Fatal("accepted confused frame")
		}
		left.Close()
		<-done
	}
}

func TestNativeProcessRoundTrip(t *testing.T) {
	for _, mode := range []string{"export", "refresh", "run", "revoke", "detach", "source_changed"} {
		t.Run(mode, func(t *testing.T) {
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			listener.(*net.TCPListener).SetDeadline(time.Now().Add(10 * time.Second))
			cmd := exec.Command(os.Args[0], "-test.run=^TestChildProvider$")
			nonce := bytes.Repeat([]byte{7}, 32)
			cmd.Stdin = bytes.NewReader(nonce)
			cmd.Env = append(os.Environ(), "WEGENT_PLUGIN_AUTH_FD=", "WEGENT_PLUGIN_AUTH_PORT="+fmt.Sprint(listener.Addr().(*net.TCPAddr).Port), "WEGENT_SDK_CHILD="+mode)
			var output, diagnostic bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &diagnostic
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer cmd.Process.Kill()
			socket, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			defer socket.Close()
			socket.SetDeadline(time.Now().Add(10 * time.Second))
			received := make([]byte, 32)
			if _, err := io.ReadFull(socket, received); err != nil || !bytes.Equal(received, nonce) {
				t.Fatal("capability handshake failed")
			}
			channel := Channel{socket, "test", "oauth2"}
			if mode != "export" {
				credential := Credential{"access_token": "synthetic-old-access"}
				if mode != "run" {
					credential["refresh_token"] = "synthetic-refresh"
				}
				if err := channel.Send(credential); err != nil {
					t.Fatal(err)
				}
				socket.(*net.TCPConn).CloseWrite()
			}
			if mode == "export" || mode == "refresh" {
				credential, err := channel.Receive()
				if err != nil || credential["access_token"] != "synthetic-new-access" {
					t.Fatal("native credential response failed")
				}
			}
			if err := cmd.Wait(); err != nil {
				t.Fatal("child failed", diagnostic.String())
			}
			if strings.Contains(output.String()+diagnostic.String(), "synthetic-") {
				t.Fatal("credential escaped private channel")
			}
			var metadata map[string]any
			if json.Unmarshal(output.Bytes(), &metadata) != nil {
				t.Fatal("missing public result")
			}
			if mode == "run" {
				if metadata["account"] != "alice" {
					t.Fatal("wrong business account")
				}
			} else if mode == "source_changed" {
				if metadata["status"] != "source_changed" {
					t.Fatal("missing source fence confirmation")
				}
			} else if mode == "detach" && metadata["status"] != "detached" {
				t.Fatal("missing durable detach confirmation")
			} else if mode != "detach" && metadata["status"] != "ok" {
				t.Fatal("missing success")
			}
		})
	}
}

func TestChildProvider(t *testing.T) {
	mode := os.Getenv("WEGENT_SDK_CHILD")
	if mode == "" {
		return
	}
	account := func(context.Context) (Account, error) {
		fmt.Fprintln(os.Stdout, "synthetic-export-noise")
		fmt.Fprintln(os.Stderr, "synthetic-error-noise")
		return Account{"alice", Credential{"access_token": "synthetic-new-access", "refresh_token": "synthetic-refresh"}}, nil
	}
	provider := Provider{Export: account,
		Refresh: func(ctx context.Context, value Credential) (Account, error) {
			if value["refresh_token"] != "synthetic-refresh" {
				return Account{}, ErrProvider
			}
			return account(ctx)
		},
		Revoke: func(context.Context, Credential) error { return nil },
		Detach: func(_ context.Context, id string, value Credential) error {
			if id != strings.Repeat("a", 64) || value["refresh_token"] != "synthetic-refresh" {
				return ErrProvider
			}
			fmt.Fprintln(os.Stdout, "synthetic-detach-noise")
			if mode == "source_changed" {
				return ErrSourceChanged
			}
			return nil
		},
		Allowed: func(args []string) bool { return len(args) == 1 && args[0] == "read" },
		Run: func(ctx context.Context, value Credential, args []string) error {
			if _, ok := value["refresh_token"]; ok {
				return ErrProvider
			}
			fmt.Fprintln(os.Stdout, `{"account":"alice"}`)
			return nil
		},
	}
	args := []string{mode}
	if mode == "run" {
		args = append(args, "read")
	}
	if mode == "source_changed" {
		args = []string{"detach"}
	}
	if mode == "detach" || mode == "source_changed" {
		args = append(args, strings.Repeat("a", 64))
	}
	if Serve(context.Background(), "test", "oauth2", provider, args) != nil {
		os.Exit(1)
	}
	os.Exit(0)
}
