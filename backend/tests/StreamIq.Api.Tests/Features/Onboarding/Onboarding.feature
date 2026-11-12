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

  Scenario: The gateway socket rejects unknown credentials
    When a gateway connects with credential "garbage"
    Then the gateway connection is refused

  Scenario: A heartbeat updates only the sending gateway's row
    Given "alice@home.test" has an enrolled gateway "nas"
    And "alice@home.test" has an enrolled gateway "pc"
    When gateway "nas" heartbeats with LAN URL "http://192.168.1.20:8097" and version "1.4.0"
    Then "alice@home.test" sees "nas" online at "http://192.168.1.20:8097/"
    And "alice@home.test" sees "nas" at version "1.4.0"
    And "alice@home.test" sees "pc" offline

  Scenario: A heartbeat stores liveness only; the details stay on the gateway
    Given "alice@home.test" has an enrolled gateway "nas"
    When gateway "nas" heartbeats update "1.6.0" plus old status fields "jellyfin" and "pairedClients"
    Then "alice@home.test" sees "nas" with update "1.6.0"
    And "alice@home.test" sees no "jellyfin" or "pairedClients" or "status" on "nas"

  Scenario Outline: A gateway below the minimum protocol is refused and listed as update required
    Given "alice@home.test" has an enrolled gateway "nas"
    When gateway "nas" heartbeats with protocol "<protocol>"
    Then the gateway socket is closed with 1008 "upgrade required"
    And "alice@home.test" sees "nas" with update required "true"
    And "alice@home.test" sees "nas" offline

    Examples:
      | protocol |
      | 0        |
      | none     |

  Scenario: A gateway at the current protocol is accepted
    Given "alice@home.test" has an enrolled gateway "nas"
    When gateway "nas" heartbeats with protocol "current"
    Then "alice@home.test" has gateway "nas" registered with the broker
    And "alice@home.test" sees "nas" with update required "false"

