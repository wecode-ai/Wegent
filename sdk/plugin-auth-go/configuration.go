// SPDX-License-Identifier: Apache-2.0
package pluginauth

import (
	"errors"
	"os"
	"regexp"
	"strings"
)

var ErrLocalConfiguration = errors.New("plugin_auth_invalid_local_configuration")

// LocalConfiguration returns host-validated source settings without modifying
// the interpreter environment. Run, refresh and revoke receive no source settings.
func LocalConfiguration() (map[string]string, error) {
	raw, present := os.LookupEnv("WEGENT_PLUGIN_AUTH_LOCAL_CONFIGURATION")
	if !present {
		return map[string]string{}, nil
	}
	if len(raw) > 16384 {
		return nil, ErrLocalConfiguration
	}
	value, err := strictJSON([]byte(raw))
	object, ok := value.(map[string]any)
	if err != nil || !ok || len(object) > 16 {
		return nil, ErrLocalConfiguration
	}
	result := make(map[string]string, len(object))
	for name, value := range object {
		validName, _ := regexp.MatchString(`^[A-Z][A-Z0-9_]{0,63}$`, name)
		setting, ok := value.(string)
		if !validName || !ok || setting == "" || len(setting) > 4096 || strings.ContainsRune(setting, 0) {
			return nil, ErrLocalConfiguration
		}
		result[name] = setting
	}
	return result, nil
}
