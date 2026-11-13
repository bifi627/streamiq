Feature: Households
  A user can belong to several households (tenants). Each request acts in one: the
  X-StreamIQ-Household header names it, else the user's oldest. The API only ever
  uses a household from the user's own memberships; any other id is a 404, the
  same as a household that doesn't exist. (Tenant isolation, crown jewel.)

  Background:
    Given "alice@home.test" has a gateway named "alice-nas"
    And "bob@home.test" has a gateway named "bob-nas"

  Scenario: A member of one household naming another household sees nothing of it
    When "bob@home.test" lists gateways in the household of "alice@home.test"
    Then the request is refused as not found
    When "bob@home.test" creates an enrollment token in the household of "alice@home.test"
    Then the request is refused as not found
    When "bob@home.test" removes gateway "alice-nas" in the household of "alice@home.test"
    Then the request is refused as not found
    And "alice@home.test" still lists only gateway "alice-nas"

  Scenario: A household that doesn't exist or a malformed id gets the same 404
    When "bob@home.test" lists gateways in household "00000000-0000-0000-0000-000000000042"
    Then the request is refused as not found
    When "bob@home.test" lists gateways in household "not-a-guid"
    Then the request is refused as not found

  Scenario: Without the header a user acts in their oldest household
    When "bob@home.test" lists gateways without naming a household
    Then the list holds exactly "bob-nas"

  Scenario: A user in two households sees each one only with the matching header
    Given "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" lists gateways in the household of "alice@home.test"
    Then the list holds exactly "alice-nas"
    When "bob@home.test" lists gateways in the household of "bob@home.test"
    Then the list holds exactly "bob-nas"
    When "bob@home.test" lists gateways without naming a household
    Then the list holds exactly "bob-nas"
    And "bob@home.test" is "admin" of the household of "bob@home.test" and "member" of the household of "alice@home.test"

  Scenario: A removed membership loses access right away
    Given "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" lists gateways in the household of "alice@home.test"
    Then the list holds exactly "alice-nas"
    When the membership of "bob@home.test" in the household of "alice@home.test" is removed
    And "bob@home.test" lists gateways in the household of "alice@home.test"
    Then the request is refused as not found
    When "bob@home.test" lists gateways without naming a household
    Then the list holds exactly "bob-nas"

  Scenario: Only an admin enrolls or removes gateways; a member still lists them
    Given "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" lists gateways in the household of "alice@home.test"
    Then the list holds exactly "alice-nas"
    When "bob@home.test" creates an enrollment token in the household of "alice@home.test"
    Then the request is refused as forbidden
    When "bob@home.test" removes gateway "alice-nas" in the household of "alice@home.test"
    Then the request is refused as forbidden
    When "alice@home.test" creates an enrollment token in the household of "alice@home.test"
    Then the request succeeds
    When "alice@home.test" removes gateway "alice-nas" in the household of "alice@home.test"
    Then the request succeeds
