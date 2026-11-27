package persistence

import (
	"strings"

	. "github.com/Masterminds/squirrel"
	"github.com/navidrome/navidrome/db"
)

// lyricsFilter matches songs whose stored lyrics contain every word of the query (the last one as
// a prefix, so it works while typing). It uses its own index, see db.LyricsFTSTable.
func lyricsFilter(_ string, value any) Sqlizer {
	text, _ := value.(string)
	text = strings.TrimSpace(text)
	if text == "" {
		return Eq{"1": "0"}
	}
	// The unicode61 tokenizer makes one token of a whole run of CJK text, and a query that is all
	// punctuation leaves no tokens: neither can be matched through the index.
	q, _ := buildFTS5Query(text)
	if q == "" || containsCJK(text) {
		return Like{"media_file.lyrics": "%" + likeEscaper.Replace(text) + "%"}
	}
	return Expr("media_file.rowid IN (SELECT rowid FROM "+db.LyricsFTSTable+" WHERE "+db.LyricsFTSTable+" MATCH ?)", q)
}

var likeEscaper = strings.NewReplacer(`%`, ``, `_`, ``)
