Feature: Gateway onboarding
  A one-time enrollment token binds a new gateway to the token owner's tenant;
  the gateway then authenticates with its long-lived credential. Secrets are
  single-use / hashed, and a gateway only ever touches its own row.

  Scenario: An enrollment token works exactly once
    Given "alice@home.test" created an enrollment token
    When a gateway enrolls with that token
    Then the enrollment is accepted
    When a gateway enrolls with that token
    Then the enrollment is rejected

  Scenario: An expired enrollment token is rejected
    Given "alice@home.test" created an enrollment token
    And the token has expired
    When a gateway enrolls with that token
    Then the enrollment is rejected

  Scenario: An enrolled gateway belongs to the token owner's tenant only
    Given "alice@home.test" created an enrollment token
    When a gateway enrolls with that token
    Then "alice@home.test" sees 1 gateway
    And "bob@home.test" sees 0 gateways

  # The gateway socket and its heartbeats are the Go API's (api/internal/broker).
