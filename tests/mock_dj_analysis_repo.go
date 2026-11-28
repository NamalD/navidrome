package tests

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"

	"github.com/navidrome/navidrome/model"
)

// MockDJAnalysisRepo keeps DJ analyses in memory.
type MockDJAnalysisRepo struct {
	mu   sync.Mutex
	Data map[string]model.DJAnalysis
	Err  error
}

func (m *MockDJAnalysisRepo) Get(id string) (*model.DJAnalysis, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return nil, m.Err
	}
	a, ok := m.Data[id]
	if !ok {
		return nil, model.ErrNotFound
	}
	return &a, nil
}

func (m *MockDJAnalysisRepo) GetAll() ([]model.DJAnalysis, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return nil, m.Err
	}
	out := make([]model.DJAnalysis, 0, len(m.Data))
	for _, a := range m.Data {
		out = append(out, a)
	}
	return out, nil
}

func (m *MockDJAnalysisRepo) Put(id string, analysis []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return m.Err
	}
	sum := sha256.Sum256(analysis)
	m.Data[id] = model.DJAnalysis{MediaFileID: id, Analysis: string(analysis), Checksum: hex.EncodeToString(sum[:]), UpdatedAt: time.Now()}
	return nil
}

func (m *MockDJAnalysisRepo) Checksums() (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Err != nil {
		return nil, m.Err
	}
	out := map[string]string{}
	for id, a := range m.Data {
		out[id] = a.Checksum
	}
	return out, nil
}
