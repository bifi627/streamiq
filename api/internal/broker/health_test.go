package broker_test

import (
	"testing"

	"streamiq/api/internal/apitest"
)

// The heartbeat carries the gateway's telemetry level, and at `full` the box's health.
// The broker keeps the level on the gateway and a gateway_health row when the health
// changes or the latest row is 5 minutes old, never two rows within 25 seconds. `off`
// stores nothing new and keeps the rows. Reading them is the gateways slice's.

func full(jellyfin string, tunnels int) map[string]any {
	return map[string]any{"telemetry": "full", "health": map[string]any{
		"jellyfin": map[string]any{"reachable": true, "version": jellyfin},
		"os":       "linux", "arch": "amd64", "transcoding": "none", "tunnels": tunnels, "cpu": 12.5, "memory": 40,
	}}
}

func withVersion(m map[string]any, v string) map[string]any { m["version"] = v; return m }

func healthRows(t *testing.T, g *gw) int {
	t.Helper()
	return apitest.Scalar[int](t, `SELECT count(*) FROM gateway_health WHERE "GatewayId" = $1`, g.id)
}

// latest is the latest row's Jellyfin version, tunnels and gateway version.
func latest(t *testing.T, g *gw) string {
	t.Helper()
	return apitest.Scalar[string](
		t,
		`SELECT concat_ws('|', "JellyfinVersion", "Tunnels", coalesce("GatewayVersion", 'none'))
		FROM gateway_health WHERE "GatewayId" = $1 ORDER BY "At" DESC LIMIT 1`,
		g.id,
	)
}

func age(t *testing.T, g *gw, interval string) {
	t.Helper()
	apitest.Exec(t, `UPDATE gateway_health SET "At" = "At" - $2::interval WHERE "GatewayId" = $1`, g.id, interval)
}

func TestAFullHeartbeatStoresTheLevelAndAHealthRow(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, full("10.11.2", 1))
	row := apitest.Scalar[string](t, `SELECT concat_ws('|', "TenantId", "Level", "JellyfinReachable", "Os", "Arch",
		"Transcoding", "Cpu", "Memory") FROM gateway_health WHERE "GatewayId" = $1`, nas.id)
	if got := gatewayCols(t, nas, `"Telemetry"`); got != "full" || healthRows(t, nas) != 1 ||
		latest(t, nas) != "10.11.2|1|none" || row != nas.tenant+"|full|t|linux|amd64|none|12.5|40" {
		t.Fatalf("%s, %d rows, %s, %s", got, healthRows(t, nas), latest(t, nas), row)
	}
}

func TestOnlyAChangeMakesANewRowNotTheLiveCounts(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, full("10.11.2", 1))
	s.heartbeat(nas, full("10.11.2", 3))
	if healthRows(t, nas) != 1 {
		t.Fatal("live counts made a row")
	}
	age(t, nas, "25 seconds")
	s.heartbeat(nas, full("10.11.3", 3))
	if healthRows(t, nas) != 2 || latest(t, nas) != "10.11.3|3|none" {
		t.Fatal(latest(t, nas))
	}
}

// The heartbeat comes every 30 s: a gateway flipping a field on every message adds no more.
func TestAChangeWithin25SecondsOfTheLatestRowWaits(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, full("10.11.2", 1))
	s.heartbeat(nas, full("10.11.3", 1))
	s.heartbeat(nas, full("10.11.4", 1))
	if healthRows(t, nas) != 1 || latest(t, nas) != "10.11.2|1|none" {
		t.Fatal(latest(t, nas))
	}
}

func TestAnUnchangedBoxStillGetsARowEvery5Minutes(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, full("10.11.2", 1))
	age(t, nas, "4 minutes 59 seconds")
	s.heartbeat(nas, full("10.11.2", 2))
	if healthRows(t, nas) != 1 {
		t.Fatal("a row before 5 minutes")
	}
	age(t, nas, "1 second")
	s.heartbeat(nas, full("10.11.2", 2))
	if healthRows(t, nas) != 2 || latest(t, nas) != "10.11.2|2|none" {
		t.Fatal(latest(t, nas))
	}
}

func TestOffOrAnUnknownLevelStoresNothingNewAndKeepsTheRows(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, full("10.11.2", 1))
	for _, level := range []any{"off", "basic", "FULL", 5} {
		age(t, nas, "10 minutes")
		m := full("10.11.3", 1)
		m["telemetry"] = level
		s.heartbeat(nas, m)
		if got := gatewayCols(t, nas, `"Telemetry"`); got != "off" || healthRows(t, nas) != 1 {
			t.Fatalf("%v: %s, %d rows", level, got, healthRows(t, nas))
		}
	}
}

func TestAGatewayTooOldToSendALevelHasNoneAndStoresNothing(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, map[string]any{"telemetry": nil, "health": full("10.11.2", 1)["health"]})
	if got := gatewayCols(t, nas, `coalesce("Telemetry", 'none')`); got != "none" || healthRows(t, nas) != 0 {
		t.Fatalf("%s, %d rows", got, healthRows(t, nas))
	}
}

// Row-level security itself, not the gateway id: a row of another household naming this
// gateway (impossible in practice) is never read (an equal one would stop the insert).
func TestAnotherHouseholdsHealthRowsAreNeverRead(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	apitest.Exec(t, `INSERT INTO gateway_health ("Id", "TenantId", "GatewayId", "At", "Level", "JellyfinReachable",
		"JellyfinVersion", "Os", "Arch", "Transcoding") VALUES (uuidv7(), $1, $2, now(), 'full', true, '10.11.2', 'linux',
		'amd64', 'none')`, s.household("eve@home.test"), nas.id)
	s.heartbeat(nas, full("10.11.2", 1))
	if healthRows(t, nas) != 2 {
		t.Fatalf("%d rows", healthRows(t, nas))
	}
	s.heartbeat(nas, map[string]any{"telemetry": "off"})
	if n := apitest.Scalar[int](
		t,
		`SELECT count(*) FROM gateway_health WHERE "TenantId" = $1`,
		s.household("eve@home.test"),
	); n != 1 {
		t.Fatal("eve's row is gone")
	}
}

func TestAChangedGatewayVersionMakesARowAndIsStoredWithIt(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.heartbeat(nas, withVersion(full("10.11.2", 1), "1.4.0"))
	if latest(t, nas) != "10.11.2|1|1.4.0" {
		t.Fatal(latest(t, nas))
	}
	age(t, nas, "25 seconds")
	s.heartbeat(nas, withVersion(full("10.11.2", 1), "1.5.0"))
	if healthRows(t, nas) != 2 || latest(t, nas) != "10.11.2|1|1.5.0" {
		t.Fatal(latest(t, nas))
	}
}
