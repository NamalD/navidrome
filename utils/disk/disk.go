// Package disk reports how full the filesystem that holds a path is.
package disk

// Usage is the space on the filesystem that holds a path, in bytes. Free is what an unprivileged process can still
// write, so Used+Free can be less than Total when the filesystem reserves blocks for root (as df reports it).
type Usage struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}
