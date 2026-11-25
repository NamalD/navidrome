package nativeapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/utils/disk"
)

// Storage endpoint (admin only): how full the disk that holds each library is
func (api *Router) addStorageRoute(r chi.Router) {
	r.Get("/storage", getStorage(api.ds))
}

type libraryStorage struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	disk.Usage
}

func getStorage(ds model.DataStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		libs, err := ds.Library(ctx).GetAll()
		if err != nil {
			log.Error(ctx, "Error getting libraries", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		storage := make([]libraryStorage, 0, len(libs))
		for _, lib := range libs {
			usage, err := disk.GetUsage(lib.Path)
			if err != nil {
				// A library whose folder can't be read (e.g. an unmounted share) is left out rather than failing all
				log.Warn(ctx, "Error getting disk usage for library", "library", lib.Name, "path", lib.Path, err)
				continue
			}
			storage = append(storage, libraryStorage{ID: lib.ID, Name: lib.Name, Usage: usage})
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(storage); err != nil {
			log.Error(ctx, "Error encoding storage response", err)
		}
	}
}
