package disk_test

import (
	"path/filepath"

	"github.com/navidrome/navidrome/utils/disk"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("GetUsage", func() {
	It("reports the space on the filesystem that holds a folder", func() {
		usage, err := disk.GetUsage(GinkgoT().TempDir())
		Expect(err).ToNot(HaveOccurred())
		Expect(usage.Total).To(BeNumerically(">", 0))
		Expect(usage.Used).To(BeNumerically("<=", usage.Total))
		Expect(usage.Free).To(BeNumerically("<=", usage.Total-usage.Used))
	})

	It("fails for a path that does not exist", func() {
		_, err := disk.GetUsage(filepath.Join(GinkgoT().TempDir(), "missing"))
		Expect(err).To(HaveOccurred())
	})
})
