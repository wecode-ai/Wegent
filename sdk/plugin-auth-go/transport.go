// SPDX-License-Identifier: Apache-2.0
// Package pluginauth implements the native accountAuth channel for embedded CLIs.
package pluginauth

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"os"
	"strconv"
	"time"
	"unicode/utf8"
)

const MaxFrameBytes = 65536
const Version = "0.3.0"

var ErrProtocol = errors.New("plugin_auth_invalid_transport")

type Credential map[string]any

// Channel carries provider credentials only on a capability-authenticated socket.
type Channel struct {
	net.Conn
	Connector, CredentialType string
}

func Connect(connector, credentialType string) (*Channel, error) {
	if os.Getenv("WEGENT_PLUGIN_AUTH_FD") != "" {
		return nil, ErrProtocol
	}
	port, err := strconv.ParseUint(os.Getenv("WEGENT_PLUGIN_AUTH_PORT"), 10, 16)
	if err != nil || port == 0 {
		return nil, ErrProtocol
	}
	nonce := make([]byte, 32)
	if _, err := io.ReadFull(os.Stdin, nonce); err != nil {
		return nil, ErrProtocol
	}
	conn, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port))), 5*time.Second)
	if err != nil {
		return nil, ErrProtocol
	}
	if err := conn.SetDeadline(time.Now().Add(5 * time.Minute)); err != nil {
		conn.Close()
		return nil, ErrProtocol
	}
	if err := writeAll(conn, nonce); err != nil {
		conn.Close()
		return nil, ErrProtocol
	}
	return &Channel{conn, connector, credentialType}, nil
}

func (c *Channel) Receive() (Credential, error) {
	var length uint32
	if binary.Read(c.Conn, binary.BigEndian, &length) != nil || length == 0 || length > MaxFrameBytes {
		return nil, ErrProtocol
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(c.Conn, data); err != nil {
		return nil, ErrProtocol
	}
	value, err := strictJSON(data)
	frame, ok := value.(map[string]any)
	if err != nil || !ok || len(frame) != 4 || frame["protocolVersion"] != json.Number("1") || frame["connectorSlug"] != c.Connector || frame["credentialType"] != c.CredentialType {
		return nil, ErrProtocol
	}
	credential, ok := frame["credential"].(map[string]any)
	if !ok || validate(Credential(credential), c.CredentialType) != nil {
		return nil, ErrProtocol
	}
	return Credential(credential), nil
}

func (c *Channel) Send(credential Credential) error {
	if err := validate(credential, c.CredentialType); err != nil {
		return err
	}
	data, err := json.Marshal(map[string]any{"protocolVersion": 1, "connectorSlug": c.Connector, "credentialType": c.CredentialType, "credential": credential})
	if err != nil || len(data) == 0 || len(data) > MaxFrameBytes {
		return ErrProtocol
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(data)))
	if writeAll(c.Conn, prefix[:]) != nil || writeAll(c.Conn, data) != nil {
		return ErrProtocol
	}
	return nil
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func strictJSON(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, ErrProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeValue(decoder, 0)
	if err != nil {
		return nil, ErrProtocol
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, ErrProtocol
	}
	return value, nil
}

func decodeValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, ErrProtocol
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token {
	case json.Delim('{'):
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			key, ok := keyToken.(string)
			if err != nil || !ok {
				return nil, ErrProtocol
			}
			if _, exists := object[key]; exists {
				return nil, ErrProtocol
			}
			value, err := decodeValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
			return nil, ErrProtocol
		}
		return object, nil
	case json.Delim('['):
		array := make([]any, 0)
		for decoder.More() {
			value, err := decodeValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim(']') {
			return nil, ErrProtocol
		}
		return array, nil
	default:
		if number, ok := token.(json.Number); ok {
			value, err := number.Float64()
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, ErrProtocol
			}
		}
		if _, delimiter := token.(json.Delim); delimiter {
			return nil, ErrProtocol
		}
		return token, nil
	}
}
