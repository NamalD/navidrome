package nativeapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/core/downloader"
	"github.com/navidrome/navidrome/log"
)

// Downloader endpoints (admin only): find albums with the download service and have it add them to the library
func (api *Router) addDownloaderRoute(r chi.Router) {
	if api.downloader == nil || !api.downloader.Enabled() {
		return
	}
	r.Route("/downloader", func(r chi.Router) {
		r.Get("/search", searchDownloads(api.downloader))
		r.Get("/job", getDownloadJobs(api.downloader))
		r.Post("/job", startDownload(api.downloader))
	})
}

func searchDownloads(dl downloader.Downloader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if query == "" {
			http.Error(w, "missing parameter q", http.StatusBadRequest)
			return
		}
		results, err := dl.Search(ctx, query)
		if err != nil {
			log.Error(ctx, "Error searching the download service", "query", query, err)
			http.Error(w, "Download service unavailable", http.StatusBadGateway)
			return
		}
		writeDownloaderResponse(w, r, http.StatusOK, results)
	}
}

func getDownloadJobs(dl downloader.Downloader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		jobs, err := dl.Jobs(ctx)
		if err != nil {
			log.Error(ctx, "Error listing downloads", err)
			http.Error(w, "Download service unavailable", http.StatusBadGateway)
			return
		}
		writeDownloaderResponse(w, r, http.StatusOK, jobs)
	}
}

func startDownload(dl downloader.Downloader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var req downloader.Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		job, err := dl.Start(ctx, req)
		if errors.Is(err, downloader.ErrInvalidURL) {
			http.Error(w, "url must be an https link", http.StatusBadRequest)
			return
		}
		if err != nil {
			log.Error(ctx, "Error starting download", "url", req.URL, err)
			http.Error(w, "Download service unavailable", http.StatusBadGateway)
			return
		}
		writeDownloaderResponse(w, r, http.StatusCreated, job)
	}
}

func writeDownloaderResponse(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Error(r.Context(), "Error encoding downloader response", err)
	}
}
