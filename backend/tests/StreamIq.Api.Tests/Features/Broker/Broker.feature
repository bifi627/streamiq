Feature: Signaling broker
  A browser reaches gateways of its own tenant only, and a gateway can only answer
  sessions opened for it. The broker relays signaling; it never decides trust.

  Scenario: An offer reaches the tenant's own gateway and the answer comes back
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    Then gateway "nas" receives the offer
    When gateway "nas" answers that session
    Then the browser receives the answer

  Scenario: A browser cannot reach another tenant's gateway
    Given "alice@home.test" has an online gateway "nas"
    When "bob@home.test" offers to gateway "nas"
    Then the browser is told the gateway is offline or unknown
    And gateway "nas" receives nothing

  Scenario: A gateway cannot answer another gateway's session, even knowing its id
    Given "alice@home.test" has an online gateway "nas"
    And "bob@home.test" has an online gateway "evil"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And gateway "evil" answers that session
    Then the browser receives nothing

  Scenario: A browser socket without a valid ID token is closed
    When a browser authenticates with token "garbage"
    Then the browser socket is closed

  Scenario: Removing a gateway revokes its credential and ends its sessions
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And "alice@home.test" removes gateway "nas"
    Then the removal succeeds
    And gateway "nas" is disconnected as "revoked"
    And the browser socket is closed
    And gateway "nas" can no longer connect
    And "alice@home.test" no longer lists gateway "nas"

  Scenario: A tenant cannot remove another tenant's gateway
    Given "alice@home.test" has an online gateway "nas"
    When "bob@home.test" removes gateway "nas"
    Then the removal is refused as not found
    When "alice@home.test" offers to gateway "nas"
    Then gateway "nas" receives the offer
