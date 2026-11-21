Feature: Households
  A user can belong to several households (tenants). Each request acts in one: the
  X-StreamIQ-Household header names it, else the user's oldest. The API only ever
  uses a household from the user's own memberships; any other id is a 404 marked
  "not a member", byte for byte the same as for a household that doesn't exist, so
  the app can drop a lost household (#210) without learning anything about others.
  (Tenant isolation, crown jewel.)

  Background:
    Given "alice@home.test" has a household
    And "bob@home.test" has a household

  Scenario: A member of one household naming another household sees nothing of it
    When "bob@home.test" lists members in the household of "alice@home.test"
    Then the request is refused as not a member
    When "bob@home.test" creates an invite naming the household of "alice@home.test"
    Then the request is refused as not a member
    And "alice@home.test" has no pending invites

  Scenario: A household that doesn't exist or a malformed id gets the same 404
    When "bob@home.test" lists members in household "00000000-0000-0000-0000-000000000042"
    Then the request is refused as not a member
    When "bob@home.test" lists members in household "not-a-guid"
    Then the request is refused as not a member

  Scenario: A foreign household and a missing one answer exactly alike
    When "bob@home.test" lists members in the household of "alice@home.test"
    And "bob@home.test" lists members in household "00000000-0000-0000-0000-000000000042"
    Then both answers are identical

  Scenario: Without the header a user acts in their oldest household
    When "bob@home.test" lists members without naming a household
    Then the member list holds exactly "bob@home.test"

  Scenario: A user in two households sees each one only with the matching header
    Given "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" lists members in the household of "alice@home.test"
    Then the member list holds exactly "alice@home.test, bob@home.test"
    When "bob@home.test" lists members in the household of "bob@home.test"
    Then the member list holds exactly "bob@home.test"
    When "bob@home.test" lists members without naming a household
    Then the member list holds exactly "bob@home.test"
    And "bob@home.test" is "admin" of the household of "bob@home.test" and "member" of the household of "alice@home.test"

  Scenario: A removed membership loses access right away
    Given "bob@home.test" is a member of the household of "alice@home.test"
    When "bob@home.test" lists members in the household of "alice@home.test"
    Then the member list holds exactly "alice@home.test, bob@home.test"
    When the membership of "bob@home.test" in the household of "alice@home.test" is removed
    And "bob@home.test" lists members in the household of "alice@home.test"
    Then the request is refused as not a member
    When "bob@home.test" lists members without naming a household
    Then the member list holds exactly "bob@home.test"
