package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// LyricsFTSTable is the full-text index over the lyrics stored in media_file.lyrics, kept apart from
// media_file_fts so lyrics never take part in the regular song search or its ranking.
const LyricsFTSTable = "media_file_lyrics_fts"

// lyricsText is a SQL expression for the plain text of a media_file.lyrics value (a JSON list of
// lyrics, each with a list of lines): every line of every entry, one per row of text.
func lyricsText(col string) string {
	return fmt.Sprintf(`COALESCE((
		SELECT group_concat(json_extract(ln.value, '$.value'), char(10))
		FROM json_each(%[1]s) AS ly, json_each(ly.value, '$.line') AS ln), '')`, col)
}

// hasLyrics is a SQL condition that holds when a media_file.lyrics value has anything to index.
func hasLyrics(col string) string {
	return fmt.Sprintf(`(%[1]s IS NOT NULL AND %[1]s NOT IN ('', '[]') AND json_valid(%[1]s))`, col)
}

// ensureLyricsSearch creates the lyrics index and the triggers that keep it current, and fills it
// from the existing rows the first time. It runs on every startup instead of being a migration:
// goose refuses to start once the database is ahead of a migration it has not applied, and
// a migration of ours would be ahead of any upstream one written before it but released after.
func ensureLyricsSearch(ctx context.Context, db *sql.DB) error {
	var exists bool
	err := db.QueryRowContext(ctx,
		`SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?`, LyricsFTSTable).Scan(&exists)
	if err != nil {
		return fmt.Errorf("checking for %s: %w", LyricsFTSTable, err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmts := []string{
		// contentless_delete lets the triggers remove a row by rowid alone, without repeating its text.
		`CREATE VIRTUAL TABLE IF NOT EXISTS ` + LyricsFTSTable + ` USING fts5(
			lyrics, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`,
		`CREATE TRIGGER IF NOT EXISTS ` + LyricsFTSTable + `_ai AFTER INSERT ON media_file
		WHEN ` + hasLyrics("NEW.lyrics") + `
		BEGIN
			INSERT INTO ` + LyricsFTSTable + `(rowid, lyrics) VALUES (NEW.rowid, ` + lyricsText("NEW.lyrics") + `);
		END`,
		`CREATE TRIGGER IF NOT EXISTS ` + LyricsFTSTable + `_ad AFTER DELETE ON media_file BEGIN
			DELETE FROM ` + LyricsFTSTable + ` WHERE rowid = OLD.rowid;
		END`,
		`CREATE TRIGGER IF NOT EXISTS ` + LyricsFTSTable + `_au AFTER UPDATE ON media_file
		WHEN OLD.lyrics IS NOT NEW.lyrics
		BEGIN
			DELETE FROM ` + LyricsFTSTable + ` WHERE rowid = OLD.rowid;
			INSERT INTO ` + LyricsFTSTable + `(rowid, lyrics)
			SELECT NEW.rowid, ` + lyricsText("NEW.lyrics") + ` WHERE ` + hasLyrics("NEW.lyrics") + `;
		END`,
	}
	if !exists {
		stmts = append(stmts, `INSERT INTO `+LyricsFTSTable+`(rowid, lyrics)
			SELECT rowid, `+lyricsText("media_file.lyrics")+` FROM media_file WHERE `+hasLyrics("media_file.lyrics"))
	}
	for _, stmt := range stmts {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("setting up %s (%s): %w", LyricsFTSTable, firstLine(stmt), err)
		}
	}
	return tx.Commit()
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return line
}
