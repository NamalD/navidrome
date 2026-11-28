package nativeapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/log"
	"github.com/navidrome/navidrome/model"
)

// maxDJAnalysisSize bounds an uploaded analysis. A typical one is 30-60 KB (beats, bars, a 1280-number embedding).
const maxDJAnalysisSize = 4 << 20

// addDJUploadRoute adds the endpoints contrib/djanalysis uploads through. They sit outside the user login and
// take conf.Server.DJ.UploadKey as a bearer token instead, so the desktop tool needs no admin account. Without
// a key they don't exist.
//
//	GET /dj/upload       {"<song id>": "<sha256 of the stored analysis>", ...}
//	PUT /dj/upload/{id}  the analysis JSON for song id
func (api *Router) addDJUploadRoute(r chi.Router) {
	if conf.Server.DJ.UploadKey == "" {
		return
	}
	r.With(djUploadKeyMiddleware).Route("/dj/upload", func(r chi.Router) {
		r.Get("/", api.getDJChecksums)
		r.Put("/{id}", api.putDJAnalysis)
	})
}

// addDJAnalysisRoute adds the endpoint the web player reads a song's analysis from, without the embedding
// (only the server's planner needs it).
//
//	GET /dj/analysis/{id}
func (api *Router) addDJAnalysisRoute(r chi.Router) {
	r.Get("/dj/analysis/{id}", api.getDJAnalysis)
}

func djUploadKeyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(conf.Server.DJ.UploadKey)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (api *Router) getDJChecksums(w http.ResponseWriter, r *http.Request) {
	sums, err := api.ds.DJAnalysis(r.Context()).Checksums()
	if err != nil {
		log.Error(r.Context(), "Error listing DJ analyses", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, r, sums)
}

func (api *Router) putDJAnalysis(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxDJAnalysisSize+1))
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if len(body) > maxDJAnalysisSize {
		http.Error(w, "Analysis too large", http.StatusRequestEntityTooLarge)
		return
	}
	var doc struct {
		Schema *int `json:"schema"`
	}
	if err := json.Unmarshal(body, &doc); err != nil || doc.Schema == nil {
		http.Error(w, "Expected a JSON object with a schema version", http.StatusBadRequest)
		return
	}
	exists, err := api.ds.MediaFile(ctx).Exists(id)
	if err != nil {
		log.Error(ctx, "Error checking song for DJ analysis", "id", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	if !exists {
		http.Error(w, "Song not found", http.StatusNotFound)
		return
	}
	if err := api.ds.DJAnalysis(ctx).Put(id, body); err != nil {
		log.Error(ctx, "Error storing DJ analysis", "id", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *Router) getDJAnalysis(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	// The song must be one this user can see.
	if exists, err := api.ds.MediaFile(ctx).Exists(id); err != nil || !exists {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	a, err := api.ds.DJAnalysis(ctx).Get(id)
	if errors.Is(err, model.ErrNotFound) {
		http.Error(w, "Not analysed", http.StatusNotFound)
		return
	}
	if err != nil {
		log.Error(ctx, "Error reading DJ analysis", "id", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(a.Analysis), &doc); err != nil {
		log.Error(ctx, "Stored DJ analysis is not a JSON object", "id", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	delete(doc, "embedding")
	writeJSON(w, r, doc)
}

func writeJSON(w http.ResponseWriter, r *http.Request, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Error(r.Context(), "Error encoding response", err)
	}
}
