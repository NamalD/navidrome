# Sets up djanalysis on the desktop. The venv, models, cache and temporary downloads live on ~/hdd/djanalysis
# because /home is nearly full.
HOME_DIR := $(HOME)/hdd/djanalysis
export UV_CACHE_DIR := $(HOME_DIR)/uv-cache
export UV_PROJECT_ENVIRONMENT := $(HOME_DIR)/venv
UNITS := $(HOME)/.config/systemd/user
EFFNET := https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb

.PHONY: setup test install

setup:
	mkdir -p $(HOME_DIR)/models $(HOME_DIR)/cache $(HOME_DIR)/tmp $(HOME_DIR)/torch
	uv sync
	g++ -O2 -std=c++17 -o $(HOME_DIR)/keyfinder-pcm keyfinder/keyfinder-pcm.cpp -lkeyfinder
	[ -f $(HOME_DIR)/models/discogs-effnet-bs64-1.pb ] || curl -sSfL -o $(HOME_DIR)/models/discogs-effnet-bs64-1.pb $(EFFNET)

test:
	uv run pytest -q

install: setup test
	install -Dm644 systemd/djanalysis.service $(UNITS)/djanalysis.service
	install -Dm644 systemd/djanalysis.timer $(UNITS)/djanalysis.timer
	systemctl --user daemon-reload
	systemctl --user enable --now djanalysis.timer
