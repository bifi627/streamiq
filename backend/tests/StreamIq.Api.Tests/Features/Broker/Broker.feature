Feature: Signaling broker
  A browser reaches gateways of households it is a member of only (checked for the
  gateway's household, never one the browser names), and a gateway can only answer
  sessions opened for it. The broker relays signaling; it never decides trust.

  Scenario: An offer reaches the tenant's own gateway and the answer comes back
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    Then gateway "nas" receives the offer with role "admin"
    When gateway "nas" answers that session
    Then the browser receives the answer

  Scenario: A browser cannot reach another tenant's gateway
    Given "alice@home.test" has an online gateway "nas"
    When "bob@home.test" offers to gateway "nas"
    Then the browser is told the gateway is offline or unknown
    And gateway "nas" receives nothing

  Scenario: A member of a second household reaches that household's gateway, with their role there
    Given "alice@home.test" has an online gateway "nas"
    And "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" offers to gateway "nas"
    Then gateway "nas" receives the offer with role "member"

  Scenario: Naming another household does not let a browser reach its gateway
    Given "alice@home.test" has an online gateway "nas"
    When "bob@home.test" offers to gateway "nas" naming the household of "alice@home.test"
    Then the browser is told the gateway is offline or unknown
    And gateway "nas" receives nothing

  Scenario: A removed membership loses broker access right away
    Given "alice@home.test" has an online gateway "nas"
    And "bob@home.test" is a member of the household of "alice@home.test"
    When the membership of "bob@home.test" in the household of "alice@home.test" is removed
    And "bob@home.test" offers to gateway "nas"
    Then the browser is told the gateway is offline or unknown
    And gateway "nas" receives nothing

  Scenario: A gateway cannot answer another gateway's session, even knowing its id
    Given "alice@home.test" has an online gateway "nas"
    And "bob@home.test" has an online gateway "evil"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And gateway "evil" answers that session
    Then the browser receives nothing

  Scenario: A gateway that disconnects ends its sessions right away
    Given "alice@home.test" has an online gateway "nas"
    When "alice@home.test" offers to gateway "nas"
    And gateway "nas" receives the offer
    And gateway "nas" disconnects
    Then the browser is told bye

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
