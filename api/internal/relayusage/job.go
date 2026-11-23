package relayusage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/db"
)

// Job copies the relayed bytes per gateway from Cloudflare's TURN analytics: each
// credential carries its gateway's relay_tag as customIdentifier (api/internal/turn).
type Job struct {
	DB               *db.DB
	AccountID, Token string // CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_API_TOKEN
	GraphQL          string // the analytics endpoint; tests point it at a fake
	HTTP             *http.Client
}

// FromEnv is nil without the account id and token: no Cloudflare TURN, no usage to copy.
func FromEnv(d *db.DB) *Job {
	j := &Job{
		DB:        d,
		AccountID: os.Getenv("CLOUDFLARE_ACCOUNT_ID"),
		Token:     os.Getenv("CLOUDFLARE_ANALYTICS_API_TOKEN"),
		GraphQL:   "https://api.cloudflare.com/client/v4/graphql",
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
	if j.AccountID == "" || j.Token == "" {
		return nil
	}
	return j
}

// Run syncs a minute after start, then daily, until ctx is done. A failed run is logged;
// the next day's sets both months again.
func (j *Job) Run(ctx context.Context) {
	t := time.NewTimer(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := j.Sync(ctx, time.Now()); err != nil {
			log.Printf("relay usage: not synced, next try in 24 h: %v", err)
		}
		t.Reset(24 * time.Hour)
	}
}

// Sync sets the bytes of now's UTC month and the one before. Set, never added: a rerun
// can't double count. A tag of no gateway (none, or a credential minted untagged) is skipped.
func (j *Job) Sync(ctx context.Context, now time.Time) error {
	this := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	for _, month := range []time.Time{this.AddDate(0, -1, 0), this} {
		usage, err := j.fetch(ctx, month)
		if err != nil {
			return fmt.Errorf("%s: %w", month.Format(time.DateOnly), err)
		}
		for tag, n := range usage {
			if err := j.store(ctx, tag, month, n); err != nil {
				return err
			}
		}
	}
	return nil
}

func (j *Job) store(ctx context.Context, tag string, month time.Time, n int64) error {
	var gateway, tenant string
	err := j.DB.NoTenant().QueryRow(ctx, `SELECT id::text, tenant_id::text FROM gateway_by_relay_tag($1)`, tag).
		Scan(&gateway, &tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return j.DB.InTenant(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO relay_usage (tenant_id, gateway_id, month, bytes)
			VALUES (app_tenant(), $1, $2, $3)
			ON CONFLICT (tenant_id, gateway_id, month) DO UPDATE SET bytes = excluded.bytes`, gateway, month, n)
		return err
	})
}

// pageLimit is the most groups one query returns.
// ponytail: one page; a full one fails the run rather than undercount. Past 10,000 tagged
// gateways per month, page with customIdentifier_gt.
const pageLimit = 10000

const query = `query ($account: string!, $from: Date!, $to: Date!, $limit: uint64!) {
  viewer { accounts(filter: {accountTag: $account}) {
    callsTurnUsageAdaptiveGroups(filter: {date_geq: $from, date_leq: $to}, limit: $limit,
      orderBy: [customIdentifier_ASC]) {
      dimensions { customIdentifier }
      sum { egressBytes }
    }
  } }
}`

// fetch is month's egress bytes per customIdentifier.
func (j *Job) fetch(ctx context.Context, month time.Time) (map[string]int64, error) {
	body, err := json.Marshal(map[string]any{"query": query, "variables": map[string]any{
		"account": j.AccountID,
		"from":    month.Format(time.DateOnly),
		"to":      month.AddDate(0, 1, -1).Format(time.DateOnly),
		"limit":   pageLimit,
	}})
	if err != nil {
		return nil, err
	}
	rq, err := http.NewRequestWithContext(ctx, http.MethodPost, j.GraphQL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	rq.Header.Set("Authorization", "Bearer "+j.Token)
	rq.Header.Set("Content-Type", "application/json")
	rs, err := j.HTTP.Do(rq)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rs.Body.Close() }()
	if rs.StatusCode/100 != 2 {
		return nil, fmt.Errorf("analytics: %s", rs.Status)
	}
	var out struct {
		Data struct {
			Viewer struct {
				Accounts []struct {
					Groups []struct {
						Dimensions struct{ CustomIdentifier string }
						Sum        struct{ EgressBytes int64 }
					} `json:"callsTurnUsageAdaptiveGroups"`
				}
			}
		}
		Errors []struct{ Message string }
	}
	if err := json.NewDecoder(rs.Body).Decode(&out); err != nil {
		return nil, err
	}
	if len(out.Errors) > 0 {
		return nil, fmt.Errorf("analytics: %s", out.Errors[0].Message)
	}
	if len(out.Data.Viewer.Accounts) != 1 {
		return nil, errors.New("analytics: no such account")
	}
	groups := out.Data.Viewer.Accounts[0].Groups
	if len(groups) >= pageLimit {
		return nil, errors.New("analytics: a full page, the rest unread")
	}
	usage := map[string]int64{}
	for _, g := range groups {
		usage[g.Dimensions.CustomIdentifier] += g.Sum.EgressBytes
	}
	return usage, nil
}
