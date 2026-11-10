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

  Scenario: A heartbeat's status snapshot reaches the web app, sanitized
    Given "alice@home.test" has an enrolled gateway "nas"
    When gateway "nas" heartbeats a status with Jellyfin token "ok", 2 paired clients and an extra field "clientNames"
    Then "alice@home.test" sees "nas" with Jellyfin token "ok" and 2 paired clients
    And "alice@home.test" sees no "clientNames" in the status of "nas"
