Feature: Tunnel telemetry
  The broker and the gateway record each tunnel, not the browser (#390): a routed
  offer inserts the row (id = the broker session), the browser's socket closing
  stamps its end, and the gateway's report at the tunnel's end fills in route,
  bytes, failure, use and active time, only for its own rows. The browser adds its measured
  throughput to its own tunnel only. Rows are tenant-owned (the global filter).

  Scenario: A routed offer writes the tunnel row for the gateway's household and the user
    Given "alice@home.test" has an online gateway "nas"
    And "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    Then the tunnel is stored for gateway "nas" in the household of "alice@home.test" by "bob@home.test"
    And the tunnel has no end time

  Scenario: A refused offer writes no row
    Given "alice@home.test" has an online gateway "nas"
    When "bob@home.test" offers to gateway "nas"
    Then the browser is told the gateway is offline or unknown
    And no tunnel is stored

  Scenario: Closing the browser socket ends the tunnel
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And the browser closes its socket
    Then the tunnel gets an end time

  Scenario: An offer that fails on its way to the gateway still ends its tunnel and session
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas" an SDP the broker can't relay
    Then the tunnel gets an end time
    And the broker holds no session for gateway "nas"

  Scenario: The gateway's report fills its own tunnel, also after the browser left
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And the browser closes its socket
    And the tunnel gets an end time
    And gateway "nas" reports that tunnel as relayed with 5000 bytes sent
    Then the tunnel is stored as relayed with 5000 bytes sent and no failure
    And the tunnel was for "playback", active for 4200 ms

  Scenario: A second report for the same tunnel is ignored
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And gateway "nas" reports that tunnel as relayed with 5000 bytes sent
    And gateway "nas" reports that tunnel as failed because "ice failed"
    Then the tunnel is stored as relayed with 5000 bytes sent and no failure

  # Same household on purpose: the tenant filter would hide another household's row
  # anyway, so this is what proves the gateway check itself.
  Scenario: A gateway cannot report another gateway's tunnel, even in the same household
    Given "alice@home.test" has an online gateway "nas"
    And "alice@home.test" has an online gateway "evil"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And gateway "evil" reports that tunnel as relayed with 5000 bytes sent
    Then the tunnel has no report

  Scenario: The browser adds its measured throughput to its own tunnel
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And "alice@home.test" reports 20000 kbps for that tunnel
    Then the throughput is accepted
    And the tunnel has 20000 kbps

  Scenario: Nobody else can set a tunnel's throughput
    Given "alice@home.test" has an online gateway "nas"
    And "carol@home.test" is a member of the household of "alice@home.test"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And "bob@home.test" reports 1 kbps for that tunnel
    Then the request is refused with 404
    When "carol@home.test" reports 1 kbps for that tunnel naming the household of "alice@home.test"
    Then the request is refused with 404
    And the tunnel has no throughput

  Scenario: Deleting the user keeps the tunnel, without its user
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And the users row of "alice@home.test" is deleted
    Then the tunnel is kept without a user

  # A failed tunnel moved no bytes: its report still counts (bytes >= 0, not > 0).
  Scenario: A failed tunnel's report with 0 bytes is recorded with all its fields
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And gateway "nas" reports that tunnel as failed over IPv6 TCP with 0 bytes
    Then the tunnel is stored as failed over IPv6 TCP with 0 bytes
    And the tunnel has no use and no active time
