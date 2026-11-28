package nativeapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/core/djmix"
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

// addDJAnalysisRoute adds the endpoints the web player mixes with: a song's analysis, without the embedding
// (only the planner needs it), and the planner's choice of what to play next.
//
//	GET /dj/analysis/{id}
//	GET /dj/next?current=<id>&rate=<playback rate>&semitones=<n>&exclude=<id>...&history=<id>...
func (api *Router) addDJAnalysisRoute(r chi.Router) {
	r.Get("/dj/analysis/{id}", api.getDJAnalysis)
	r.Get("/dj/next", api.getDJNext)
}

func (api *Router) getDJNext(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	req := djmix.Request{
		Current: q.Get("current"),
		Rate:    1,
		Exclude: splitIDs(q["exclude"]),
		History: splitIDs(q["history"]),
	}
	if req.Current == "" {
		http.Error(w, "current is required", http.StatusBadRequest)
		return
	}
	if v := q.Get("rate"); v != "" {
		rate, err := strconv.ParseFloat(v, 64)
		if err != nil || rate <= 0 || rate > 4 {
			http.Error(w, "bad rate", http.StatusBadRequest)
			return
		}
		req.Rate = rate
	}
	if v := q.Get("semitones"); v != "" {
		semis, err := strconv.Atoi(v)
		if err != nil || semis < -12 || semis > 12 {
			http.Error(w, "bad semitones", http.StatusBadRequest)
			return
		}
		req.Semitones = semis
	}
	songs, err := api.djLibrary.Songs(ctx)
	if err != nil {
		log.Error(ctx, "Error loading DJ analyses", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	// Only songs this user can see, that are still on disk.
	mf := api.ds.MediaFile(ctx)
	allowed := func(id string) bool {
		m, err := mf.Get(id)
		return err == nil && !m.Missing
	}
	plan, err := djmix.Choose(songs, req, rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64())), allowed)
	switch {
	case errors.Is(err, djmix.ErrNotAnalysed):
		http.Error(w, "The playing song has not been analysed", http.StatusNotFound)
		return
	case errors.Is(err, djmix.ErrNoCandidates):
		http.Error(w, "No song left to mix into", http.StatusNotFound)
		return
	case err != nil:
		log.Error(ctx, "Error planning DJ transition", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, r, plan)
}

// splitIDs accepts both repeated parameters and comma-separated lists.
func splitIDs(values []string) []string {
	var out []string
	for _, v := range values {
		for _, id := range strings.Split(v, ",") {
			if id = strings.TrimSpace(id); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
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
