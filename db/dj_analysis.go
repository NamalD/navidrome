package db

import (
	"context"
	"database/sql"
	"fmt"
)

// DJAnalysisTable holds, per song, the analysis the DJ mixer works from (beats, downbeats, key, phrases,
// loudness, a sound embedding), as uploaded by contrib/djanalysis. Navidrome does not analyse audio itself.
const DJAnalysisTable = "media_file_dj_analysis"

// ensureDJAnalysis creates the DJ analysis table. Like ensureLyricsSearch it runs on every startup instead of
// being a migration, so an upstream migration released later can't find the database ahead of it.
func ensureDJAnalysis(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS `+DJAnalysisTable+` (
		media_file_id VARCHAR(255) NOT NULL PRIMARY KEY REFERENCES media_file(id) ON DELETE CASCADE,
		analysis      TEXT NOT NULL,
		checksum      VARCHAR(64) NOT NULL,
		updated_at    DATETIME NOT NULL
	)`)
	if err != nil {
		return fmt.Errorf("creating %s: %w", DJAnalysisTable, err)
	}
	return nil
}
