package persistence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	. "github.com/Masterminds/squirrel"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/pocketbase/dbx"
)

type djAnalysisRepository struct {
	sqlRepository
}

func NewDJAnalysisRepository(ctx context.Context, db dbx.Builder) model.DJAnalysisRepository {
	r := &djAnalysisRepository{}
	r.ctx = ctx
	r.db = db
	r.tableName = dbDJAnalysisTable
	return r
}

const dbDJAnalysisTable = db.DJAnalysisTable

type djAnalysisRow struct {
	MediaFileID string    `db:"media_file_id"`
	Analysis    string    `db:"analysis"`
	Checksum    string    `db:"checksum"`
	UpdatedAt   time.Time `db:"updated_at"`
}

func (row djAnalysisRow) toModel() model.DJAnalysis {
	return model.DJAnalysis{MediaFileID: row.MediaFileID, Analysis: row.Analysis, Checksum: row.Checksum, UpdatedAt: row.UpdatedAt}
}

func (r *djAnalysisRepository) Get(mediaFileID string) (*model.DJAnalysis, error) {
	var row djAnalysisRow
	err := r.queryOne(Select("*").From(r.tableName).Where(Eq{"media_file_id": mediaFileID}), &row)
	if err != nil {
		return nil, err
	}
	a := row.toModel()
	return &a, nil
}

func (r *djAnalysisRepository) GetAll() ([]model.DJAnalysis, error) {
	var rows []djAnalysisRow
	if err := r.queryAll(Select("*").From(r.tableName), &rows); err != nil {
		return nil, err
	}
	out := make([]model.DJAnalysis, len(rows))
	for i, row := range rows {
		out[i] = row.toModel()
	}
	return out, nil
}

func (r *djAnalysisRepository) Put(mediaFileID string, analysis []byte) error {
	sum := sha256.Sum256(analysis)
	insert := Insert(r.tableName).
		Columns("media_file_id", "analysis", "checksum", "updated_at").
		Values(mediaFileID, string(analysis), hex.EncodeToString(sum[:]), time.Now()).
		Suffix("ON CONFLICT(media_file_id) DO UPDATE SET analysis = excluded.analysis, checksum = excluded.checksum, updated_at = excluded.updated_at")
	_, err := r.executeSQL(insert)
	return err
}

func (r *djAnalysisRepository) Checksums() (map[string]string, error) {
	var rows []djAnalysisRow
	err := r.queryAll(Select("media_file_id", "checksum").From(r.tableName), &rows)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, row := range rows {
		out[row.MediaFileID] = row.Checksum
	}
	return out, nil
}
