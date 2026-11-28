package persistence

import (
	"strings"

	. "github.com/Masterminds/squirrel"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
)

// lyricsMatch returns the FTS5 query for a lyrics search, or "" when the index can't answer it: the
// unicode61 tokenizer makes one token of a whole run of CJK text, and a query that is all punctuation
// leaves no tokens.
func lyricsMatch(text string) string {
	q, _ := buildFTS5Query(text)
	if containsCJK(text) {
		return ""
	}
	return q
}

func lyricsLike(text string) Sqlizer {
	return Like{"media_file.lyrics": "%" + likeEscaper.Replace(text) + "%"}
}

// lyricsFilter matches songs whose lyrics contain every word of the query (the last one as a prefix,
// so it works while typing). It uses its own index, see db.LyricsFTSTable.
func lyricsFilter(_ string, value any) Sqlizer {
	text, _ := value.(string)
	text = strings.TrimSpace(text)
	if text == "" {
		return Eq{"1": "0"}
	}
	q := lyricsMatch(text)
	if q == "" {
		return lyricsLike(text)
	}
	return Expr("media_file.rowid IN (SELECT rowid FROM "+db.LyricsFTSTable+" WHERE "+db.LyricsFTSTable+" MATCH ?)", q)
}

// searchLyrics lists the songs whose lyrics match text, best matches first.
func (r *mediaFileRepository) searchLyrics(text string, opts model.QueryOptions) (model.MediaFiles, error) {
	text = strings.TrimSpace(text)
	q := lyricsMatch(text)
	if q == "" {
		if opts.Filters == nil {
			opts.Filters = lyricsLike(text)
		} else {
			opts.Filters = And{opts.Filters, lyricsLike(text)}
		}
		return r.GetAll(opts)
	}
	fts := db.LyricsFTSTable
	sq := r.selectMediaFile(opts).
		Join(fts+" ON "+fts+".rowid = media_file.rowid AND "+fts+" MATCH ?", q).
		OrderBy("bm25(" + fts + ")")
	var res dbMediaFiles
	if err := r.queryAll(sq, &res); err != nil {
		return nil, err
	}
	mfs := res.toModels()
	r.hydrateArtwork(mfs)
	return mfs, nil
}

var likeEscaper = strings.NewReplacer(`%`, ``, `_`, ``)
