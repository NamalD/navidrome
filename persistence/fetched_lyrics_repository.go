package persistence

import (
	"context"
	"encoding/json"
	"time"

	. "github.com/Masterminds/squirrel"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/pocketbase/dbx"
)

type fetchedLyricsRepository struct {
	sqlRepository
}

func NewFetchedLyricsRepository(ctx context.Context, db dbx.Builder) model.FetchedLyricsRepository {
	r := &fetchedLyricsRepository{}
	r.ctx = ctx
	r.db = db
	r.tableName = dbFetchedLyricsTable
	return r
}

const dbFetchedLyricsTable = db.FetchedLyricsTable

func (r *fetchedLyricsRepository) Pending(retryMissingBefore time.Time, max int, exclude []string) (model.MediaFiles, error) {
	filters := And{
		Eq{"media_file.missing": false},
		Expr("media_file.lyrics IN ('', '[]')"),
		// julianday: the times are stored as text, which compares wrongly across time zones
		Expr(`NOT EXISTS (SELECT 1 FROM `+r.tableName+` AS f WHERE f.media_file_id = media_file.id
			AND julianday(f.fetched_at) >= julianday(media_file.updated_at)
			AND (f.fetched_lyrics != '[]' OR julianday(f.fetched_at) >= julianday(?)))`,
			retryMissingBefore),
	}
	if len(exclude) > 0 {
		filters = append(filters, NotEq{"media_file.id": exclude})
	}
	return NewMediaFileRepository(r.ctx, r.db).GetAll(model.QueryOptions{
		Filters: filters,
		Sort:    "created_at",
		Order:   "desc",
		Max:     max,
	})
}

func (r *fetchedLyricsRepository) Put(mediaFileID string, lyrics model.LyricList) error {
	if lyrics == nil {
		lyrics = model.LyricList{}
	}
	data, err := json.Marshal(lyrics)
	if err != nil {
		return err
	}
	insert := Insert(r.tableName).
		Columns("media_file_id", "fetched_lyrics", "fetched_at").
		Values(mediaFileID, string(data), time.Now()).
		Suffix("ON CONFLICT(media_file_id) DO UPDATE SET fetched_lyrics = excluded.fetched_lyrics, fetched_at = excluded.fetched_at")
	_, err = r.executeSQL(insert)
	return err
}
