package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// config holds the settings, read from the KEY=VALUE lines of every *.env file in the config folder
// (~/.config/nowplaylist by default), with environment variables of the same name taking precedence.
type config struct {
	LastfmUser   string // LASTFM_USER
	LastfmAPIKey string // LASTFM_APIKEY
	DBPath       string // NOWPLAYLIST_DB, default ~/.local/share/nowplaylist/history.db
}

func configDir() (string, error) {
	if d := os.Getenv("NOWPLAYLIST_CONFIG_DIR"); d != "" {
		return d, nil
	}
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "nowplaylist"), nil
}

func dataDir() (string, error) {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "nowplaylist"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "nowplaylist"), nil
}

func loadConfig() (config, error) {
	dir, err := configDir()
	if err != nil {
		return config{}, err
	}
	vals, err := readEnvDir(dir)
	if err != nil {
		return config{}, err
	}
	get := func(k string) string {
		if v, ok := os.LookupEnv(k); ok {
			return v
		}
		return vals[k]
	}
	c := config{
		LastfmUser:   get("LASTFM_USER"),
		LastfmAPIKey: get("LASTFM_APIKEY"),
		DBPath:       get("NOWPLAYLIST_DB"),
	}
	if c.DBPath == "" {
		d, err := dataDir()
		if err != nil {
			return config{}, err
		}
		c.DBPath = filepath.Join(d, "history.db")
	}
	var missing []string
	if c.LastfmUser == "" {
		missing = append(missing, "LASTFM_USER")
	}
	if c.LastfmAPIKey == "" {
		missing = append(missing, "LASTFM_APIKEY")
	}
	if len(missing) > 0 {
		return config{}, fmt.Errorf("missing %s: set them in %s/*.env or the environment", strings.Join(missing, ", "), dir)
	}
	return c, nil
}

// readEnvDir reads every *.env file in dir, in name order. A missing folder is not an error.
func readEnvDir(dir string) (map[string]string, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.env"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	vals := map[string]string{}
	for _, f := range files {
		if err := readEnvFile(f, vals); err != nil {
			return nil, err
		}
	}
	return vals, nil
}

func readEnvFile(path string, into map[string]string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("%s:%d: expected KEY=VALUE", path, n)
		}
		into[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return sc.Err()
}
