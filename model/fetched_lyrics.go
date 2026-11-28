package model

import "time"

// FetchedLyricsRepository stores the lyrics fetched for songs that have none in their tags, from the
// sources that are not stored with the song (plugins, sidecar files), so they can be searched.
type FetchedLyricsRepository interface {
	// Pending returns up to max songs, newest first, whose lyrics should be fetched: present, with no
	// lyrics in their tags, and either never fetched, fetched before the song last changed, or found
	// missing before retryMissingBefore. Songs whose id is in exclude are left out.
	Pending(retryMissingBefore time.Time, max int, exclude []string) (MediaFiles, error)
	// Put records what was fetched for a song, an empty list when nothing was found (or the fetch failed),
	// at the current time.
	Put(mediaFileID string, lyrics LyricList) error
}
