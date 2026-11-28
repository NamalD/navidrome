package model

import "time"

// DJAnalysis is the stored analysis of one song for the DJ mixer: a JSON document whose shape belongs to
// contrib/djanalysis (see its README), kept as uploaded.
type DJAnalysis struct {
	MediaFileID string
	Analysis    string
	Checksum    string // SHA-256 of Analysis, hex
	UpdatedAt   time.Time
}

// DJAnalysisRepository stores DJAnalysis per song. Rows go when their song is deleted.
type DJAnalysisRepository interface {
	Get(mediaFileID string) (*DJAnalysis, error)
	GetAll() ([]DJAnalysis, error)
	Put(mediaFileID string, analysis []byte) error
	// Checksums maps each analysed song to the checksum of its analysis, so an uploader can skip unchanged ones.
	Checksums() (map[string]string, error)
}
