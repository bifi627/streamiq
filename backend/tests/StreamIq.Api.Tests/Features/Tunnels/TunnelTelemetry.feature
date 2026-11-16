Feature: Tunnel telemetry
  Clients log each tunnel (direct vs relay, IPv4/v6, bytes, measured
  throughput) into tunnels. Rows are tenant-owned: the global filter, not the
  handler, keeps one tenant out of another's.

  Scenario: A client logs and ends a tunnel on its own gateway
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" opens a relayed tunnel on "alice-nas"
    And "alice@home.test" ends that tunnel with 5000 bytes received and 20000 kbps measured
    Then the tunnel is stored as relayed with 5000 bytes received, 20000 kbps and an end time

  Scenario: A tunnel that measured nothing ends without throughput
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" opens a relayed tunnel on "alice-nas"
    And "alice@home.test" ends that tunnel with 5000 bytes received
    Then the tunnel is stored as relayed with 5000 bytes received, no throughput and an end time

  Scenario: A failed tunnel is logged with its reason
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" logs a failed tunnel on "alice-nas" because "ice failed"
    Then the tunnel is stored as failed because "ice failed"

  Scenario: A tenant cannot log a tunnel on another tenant's gateway
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "bob@home.test" opens a relayed tunnel on "alice-nas"
    Then the request is refused with 404
    And no tunnel is stored

  Scenario: A tenant cannot end another tenant's tunnel
    Given "alice@home.test" owns a gateway named "alice-nas"
    When "alice@home.test" opens a relayed tunnel on "alice-nas"
    And "bob@home.test" ends that tunnel with 1 bytes received
    Then the request is refused with 404
    And the tunnel has no end time
