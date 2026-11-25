package nativeapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"time"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/conf/configtest"
	"github.com/navidrome/navidrome/core/auth"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/server"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Storage Endpoint", func() {
	var router http.Handler
	var adminToken, userToken string

	BeforeEach(func() {
		DeferCleanup(configtest.SetupConfig())
		conf.Server.SessionTimeout = time.Minute
		conf.Server.EnableSharing = false

		libRepo := &tests.MockLibraryRepo{}
		libRepo.SetData(model.Libraries{
			{ID: 1, Name: "Music Library", Path: GinkgoT().TempDir()},
			{ID: 2, Name: "Unmounted", Path: filepath.Join(GinkgoT().TempDir(), "missing")},
		})
		userRepo := tests.CreateMockUserRepo()
		ds := &tests.MockDataStore{MockedLibrary: libRepo, MockedUser: userRepo, MockedProperty: &tests.MockedPropertyRepo{}}
		auth.Init(ds)

		admin := model.User{ID: "admin-1", UserName: "admin", IsAdmin: true, NewPassword: "adminpass"}
		user := model.User{ID: "user-1", UserName: "user", NewPassword: "userpass"}
		Expect(userRepo.Put(&admin)).To(Succeed())
		Expect(userRepo.Put(&user)).To(Succeed())
		var err error
		adminToken, err = auth.CreateToken(&admin)
		Expect(err).ToNot(HaveOccurred())
		userToken, err = auth.CreateToken(&user)
		Expect(err).ToNot(HaveOccurred())

		router = server.JWTVerifier(New(ds, nil, nil, nil, tests.NewMockLibraryService(), tests.NewMockUserService(), nil, nil, nil, nil, nil))
	})

	It("returns the disk usage of each library that can be read", func() {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, createAuthenticatedRequest(http.MethodGet, "/storage", nil, adminToken))
		Expect(w.Code).To(Equal(http.StatusOK), w.Body.String())

		var storage []libraryStorage
		Expect(json.Unmarshal(w.Body.Bytes(), &storage)).To(Succeed())
		Expect(storage).To(HaveLen(1))
		Expect(storage[0].ID).To(Equal(1))
		Expect(storage[0].Name).To(Equal("Music Library"))
		Expect(storage[0].Total).To(BeNumerically(">", 0))
		Expect(storage[0].Used + storage[0].Free).To(BeNumerically("<=", storage[0].Total))
	})

	It("is only available to admins", func() {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, createAuthenticatedRequest(http.MethodGet, "/storage", nil, userToken))
		Expect(w.Code).To(Equal(http.StatusForbidden))
	})
})
