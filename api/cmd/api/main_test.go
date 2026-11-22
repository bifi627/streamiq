package main

import "testing"

func TestDatabaseURLFallsBackInDevelopmentOnly(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	for env, wantErr := range map[string]bool{"development": false, "": true, "production": true} {
		t.Setenv("STREAMIQ_ENV", env)
		url, err := databaseURL()
		if (err != nil) != wantErr || (err == nil && url == "") {
			t.Fatalf("STREAMIQ_ENV=%q: %q, %v", env, url, err)
		}
		if err != nil && err != errNoDatabaseURL {
			t.Fatalf("STREAMIQ_ENV=%q: %v", env, err)
		}
	}
	t.Setenv("DATABASE_URL", "postgres://db/streamiq")
	if url, err := databaseURL(); url != "postgres://db/streamiq" || err != nil {
		t.Fatalf("set: %q, %v", url, err)
	}
}
