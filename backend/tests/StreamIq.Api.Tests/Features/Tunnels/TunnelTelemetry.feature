Feature: Tunnel throughput
  The broker (Go API) writes each tunnel's row; the browser adds its measured throughput
  to its own tunnel only (#390). Rows are tenant-owned (the global filter).

  Scenario: The browser adds its measured throughput to its own tunnel
    Given "alice@home.test" has a gateway named "nas"
    And "alice@home.test" has a tunnel to gateway "nas"
    When "alice@home.test" reports 20000 kbps for that tunnel
    Then the throughput is accepted
    And the tunnel has 20000 kbps

  Scenario: Nobody else can set a tunnel's throughput
    Given "alice@home.test" has a gateway named "nas"
    And "carol@home.test" is a member of the household of "alice@home.test"
    And "alice@home.test" has a tunnel to gateway "nas"
    When "bob@home.test" reports 1 kbps for that tunnel
    Then the request is refused with 404
    When "carol@home.test" reports 1 kbps for that tunnel naming the household of "alice@home.test"
    Then the request is refused with 404
    And the tunnel has no throughput
