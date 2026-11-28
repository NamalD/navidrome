package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

const (
	// LyricsFTSTable is the full-text index over each song's lyrics, kept apart from media_file_fts so
	// lyrics never take part in the regular song search or its ranking. It indexes the lyrics in the
	// song's tags (media_file.lyrics) or, for a song without any, those fetched for it.
	LyricsFTSTable = "media_file_lyrics_fts"

	// FetchedLyricsTable holds lyrics fetched from the sources that are not stored with the song (plugins,
	// sidecar files), so they can be searched. media_file.lyrics is the scanner's, which rewrites it from
	// the tags.
	FetchedLyricsTable = "media_file_fetched_lyrics"
)

// lyricsText is a SQL expression for the plain text of a lyrics value (a JSON list of lyrics, each
// with a list of lines): every line of every entry, one per row of text, or an empty string for NULL.
func lyricsText(col string) string {
	return fmt.Sprintf(`COALESCE((
		SELECT group_concat(json_extract(ln.value, '$.value'), char(10))
		FROM json_each(%[1]s) AS ly, json_each(ly.value, '$.line') AS ln), '')`, col)
}

// hasLyrics is a SQL condition that holds when a lyrics value has anything to index.
func hasLyrics(col string) string {
	return fmt.Sprintf(`(%[1]s IS NOT NULL AND %[1]s NOT IN ('', '[]') AND json_valid(%[1]s))`, col)
}

// indexedLyrics selects, for the media_file rows matching where (aliased m), the rowid and the text the
// lyrics index holds for them, leaving out those with nothing to index.
func indexedLyrics(where string) string {
	return fmt.Sprintf(`SELECT rid, txt FROM (
		SELECT m.rowid AS rid, CASE WHEN %[1]s THEN %[2]s ELSE %[3]s END AS txt
		FROM media_file AS m WHERE %[4]s) WHERE txt != ''`,
		hasLyrics("m.lyrics"), lyricsText("m.lyrics"),
		lyricsText(fmt.Sprintf(`(SELECT f.fetched_lyrics FROM %s AS f WHERE f.media_file_id = m.id AND json_valid(f.fetched_lyrics))`, FetchedLyricsTable)),
		where)
}

// reindexLyrics is the trigger body that refreshes the lyrics index for the song with the given id.
func reindexLyrics(idExpr string) string {
	return fmt.Sprintf(`
			DELETE FROM %[1]s WHERE rowid IN (SELECT rowid FROM media_file WHERE id = %[2]s);
			INSERT INTO %[1]s(rowid, lyrics) %[3]s;`,
		LyricsFTSTable, idExpr, indexedLyrics("m.id = "+idExpr))
}

// ensureLyricsSearch sets up lyrics search (see setupLyricsSearch). It runs on every startup instead of
// being a migration: goose refuses to start once the database is ahead of a migration it has not applied,
// and a migration of ours would be ahead of any upstream one written before it but released after.
func ensureLyricsSearch(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := setupLyricsSearch(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}

// lyricsFTSExists reports whether the lyrics index has been created.
func lyricsFTSExists(ctx context.Context, q interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}) (bool, error) {
	var exists bool
	err := q.QueryRowContext(ctx,
		`SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?`, LyricsFTSTable).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("checking for %s: %w", LyricsFTSTable, err)
	}
	return exists, nil
}

// setupLyricsSearch creates the fetched lyrics table, the lyrics index and the triggers that keep the
// index current, and fills the index from the existing rows when it creates it. The triggers are
// recreated each time, so a change to them takes effect on the next start.
func setupLyricsSearch(ctx context.Context, tx *sql.Tx) error {
	exists, err := lyricsFTSExists(ctx, tx)
	if err != nil {
		return err
	}

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS ` + FetchedLyricsTable + ` (
			media_file_id VARCHAR NOT NULL PRIMARY KEY REFERENCES media_file(id) ON DELETE CASCADE,
			fetched_lyrics JSONB NOT NULL DEFAULT '[]',
			fetched_at DATETIME NOT NULL)`,
		// contentless_delete lets a row be removed by rowid alone, without repeating its text.
		`CREATE VIRTUAL TABLE IF NOT EXISTS ` + LyricsFTSTable + ` USING fts5(
			lyrics, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`,
	}
	for _, name := range []string{"_ai", "_ad", "_au", "_fetched_ai", "_fetched_ad", "_fetched_au"} {
		stmts = append(stmts, `DROP TRIGGER IF EXISTS `+LyricsFTSTable+name)
	}
	stmts = append(stmts,
		`CREATE TRIGGER `+LyricsFTSTable+`_ai AFTER INSERT ON media_file BEGIN`+reindexLyrics("NEW.id")+` END`,
		`CREATE TRIGGER `+LyricsFTSTable+`_ad AFTER DELETE ON media_file BEGIN
			DELETE FROM `+LyricsFTSTable+` WHERE rowid = OLD.rowid;
		END`,
		`CREATE TRIGGER `+LyricsFTSTable+`_au AFTER UPDATE ON media_file
		WHEN OLD.lyrics IS NOT NEW.lyrics BEGIN`+reindexLyrics("NEW.id")+` END`,
		`CREATE TRIGGER `+LyricsFTSTable+`_fetched_ai AFTER INSERT ON `+FetchedLyricsTable+`
		BEGIN`+reindexLyrics("NEW.media_file_id")+` END`,
		`CREATE TRIGGER `+LyricsFTSTable+`_fetched_ad AFTER DELETE ON `+FetchedLyricsTable+`
		BEGIN`+reindexLyrics("OLD.media_file_id")+` END`,
		`CREATE TRIGGER `+LyricsFTSTable+`_fetched_au AFTER UPDATE ON `+FetchedLyricsTable+`
		BEGIN`+reindexLyrics("NEW.media_file_id")+` END`,
	)
	if !exists {
		stmts = append(stmts, `INSERT INTO `+LyricsFTSTable+`(rowid, lyrics) `+indexedLyrics("1"))
	}
	for _, stmt := range stmts {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("setting up lyrics search (%s): %w", firstLine(stmt), err)
		}
	}
	return nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return line
}
