//go:build unix

package disk

import "golang.org/x/sys/unix"

// GetUsage returns the space on the filesystem that holds path.
func GetUsage(path string) (Usage, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return Usage{}, err
	}
	// Field types differ between platforms (and Bavail is signed on FreeBSD), so convert each one.
	bsize := uint64(st.Bsize) //nolint:gosec
	total := uint64(st.Blocks) * bsize
	free := uint64(max(int64(st.Bavail), 0)) * bsize //nolint:gosec
	used := total - uint64(st.Bfree)*bsize           //nolint:gosec
	return Usage{Total: total, Used: used, Free: free}, nil
}
