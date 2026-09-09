package pluginauth

import (
	"os"
	"strings"
	"testing"
)

func TestLocalConfigurationIsBoundedAndNeverOverridesEnvironment(t *testing.T) {
	const key = "WEGENT_PLUGIN_AUTH_LOCAL_CONFIGURATION"
	originalPath := os.Getenv("PATH")
	t.Setenv(key, `{"PATH":"/synthetic/provider"}`)
	value, err := LocalConfiguration()
	if err != nil || value["PATH"] != "/synthetic/provider" || os.Getenv("PATH") != originalPath {
		t.Fatal("configuration was not isolated")
	}
	for _, raw := range []string{`[]`, `{"MODE":1}`, `{"MODE":"a","MODE":"b"}`, `{"mixedCase":"a"}`, strings.Repeat("x", 16385)} {
		t.Setenv(key, raw)
		if _, err := LocalConfiguration(); err != ErrLocalConfiguration {
			t.Fatal("invalid configuration was accepted")
		}
	}
}
