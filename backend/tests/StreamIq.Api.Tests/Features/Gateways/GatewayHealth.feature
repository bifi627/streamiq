Feature: Gateway health
  `GET /api/gateways/{id}/health` returns a gateway's health rows of the last 7 days to
  any member, led by the latest row before them (#423). The broker (Go API) writes them.

  Scenario: Any member reads the last 7 days, led by the row before them
    Given "alice@home.test" has a gateway named "nas"
    And "bob@home.test" is a member of the household of "alice@home.test"
    And gateway "nas" has health rows 10, 8, 6 and 1 days old
    When "bob@home.test" reads the health of gateway "nas" in the household of "alice@home.test"
    Then the health read lists the rows 8, 6 and 1 days old, in that order

  Scenario: Another household's gateway or an unknown one is not found
    Given "alice@home.test" has a gateway named "nas"
    And gateway "nas" has health rows 10, 8, 6 and 1 days old
    When "eve@home.test" reads the health of gateway "nas" in the household of "eve@home.test"
    Then the health read is not found
    When "alice@home.test" reads the health of an unknown gateway
    Then the health read is not found
