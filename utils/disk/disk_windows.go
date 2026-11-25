//go:build windows

package disk

import "golang.org/x/sys/windows"

// GetUsage returns the space on the volume that holds path.
func GetUsage(path string) (Usage, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return Usage{}, err
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree); err != nil {
		return Usage{}, err
	}
	return Usage{Total: total, Used: total - totalFree, Free: free}, nil
}
