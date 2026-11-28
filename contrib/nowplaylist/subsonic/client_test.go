package subsonic

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestTokenAuthAndSongPaging(t *testing.T) {
	const total = 1234
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		f := r.PostForm
		sum := md5.Sum([]byte("secret" + f.Get("s")))
		if f.Get("u") != "bot" || f.Get("t") != hex.EncodeToString(sum[:]) || f.Get("p") != "" || f.Get("f") != "json" {
			fmt.Fprint(w, `{"subsonic-response":{"status":"failed","error":{"code":40,"message":"Wrong username or password"}}}`)
			return
		}
		if r.URL.Path != "/rest/search3" || f.Get("query") != `""` {
			t.Errorf("unexpected %s %v", r.URL.Path, f)
		}
		offset, _ := strconv.Atoi(f.Get("songOffset"))
		count, _ := strconv.Atoi(f.Get("songCount"))
		songs := "["
		for i := offset; i < total && i < offset+count; i++ {
			if i > offset {
				songs += ","
			}
			songs += fmt.Sprintf(`{"id":"s%d","title":"T%d","artist":"A"}`, i, i)
		}
		songs += "]"
		fmt.Fprintf(w, `{"subsonic-response":{"status":"ok","searchResult3":{"song":%s}}}`, songs)
	}))
	defer srv.Close()

	got, err := NewClient(srv.URL+"/", "bot", "secret").Songs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != total || got[total-1].ID != fmt.Sprintf("s%d", total-1) {
		t.Errorf("got %d songs, last %+v", len(got), got[len(got)-1])
	}

	_, err = NewClient(srv.URL, "bot", "wrong").Songs(context.Background())
	var se *Error
	if !errors.As(err, &se) || se.Code != 40 {
		t.Errorf("wrong password: err = %v", err)
	}
}
