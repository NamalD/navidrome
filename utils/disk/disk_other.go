//go:build !unix && !windows

package disk

import "errors"

// GetUsage is not supported on this platform.
func GetUsage(string) (Usage, error) {
	return Usage{}, errors.ErrUnsupported
}
