Feature: Connection telemetry
  Clients log each WebRTC session (direct vs relay, IPv4/v6, bytes, measured
  throughput) into
  connection_sessions. Rows are tenant-owned: the global filter, not the
  handler, keeps one tenant out of another's.

  Scenario: A client logs and ends a session on its own gateway
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" starts a relayed session on "alice-nas"
    And "alice@home.test" ends that session with 5000 bytes received and 20000 kbps measured
    Then the session is stored as relayed with 5000 bytes received, 20000 kbps and an end time

  Scenario: A session that measured nothing ends without throughput
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" starts a relayed session on "alice-nas"
    And "alice@home.test" ends that session with 5000 bytes received
    Then the session is stored as relayed with 5000 bytes received, no throughput and an end time

  Scenario: A failed attempt is logged with its reason
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" logs a failed attempt on "alice-nas" because "ice failed"
    Then the session is stored as failed because "ice failed"

  Scenario: A tenant cannot log a session on another tenant's gateway
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "bob@home.test" starts a relayed session on "alice-nas"
    Then the request is refused with 404
    And no session is stored

  Scenario: A tenant cannot end another tenant's session
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" starts a relayed session on "alice-nas"
    And "bob@home.test" ends that session with 1 bytes received
    Then the request is refused with 404
    And the session has no end time
