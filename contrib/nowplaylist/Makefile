# Builds nowplaylist and installs it with its systemd user timer.
BIN := $(HOME)/.local/bin/nowplaylist
UNITS := $(HOME)/.config/systemd/user

.PHONY: test install

test:
	go test ./...

install: test
	go build -o $(BIN) .
	install -Dm644 systemd/nowplaylist.service $(UNITS)/nowplaylist.service
	install -Dm644 systemd/nowplaylist.timer $(UNITS)/nowplaylist.timer
	systemctl --user daemon-reload
	systemctl --user enable --now nowplaylist.timer
