Feature: Invites
  An admin invites someone into the household with a single-use link that expires
  after 7 days. Opening it shows the household; accepting makes the signed-in user a
  member of exactly that household and touches nothing else. An expired, used or
  revoked link is a 404, like an unknown one. (Tenant isolation, crown jewel.)

  Background:
    Given "alice@home.test" has a household with gateway "alice-nas"
    And "bob@home.test" has a household with gateway "bob-nas"

  Scenario: Accepting an invite makes the user a member of that household only
    Given "alice@home.test" created an invite
    When "bob@home.test" previews the invite
    Then the preview names "alice@home.test's household" and says not a member
    When "bob@home.test" accepts the invite
    Then the answer is the household of "alice@home.test"
    And "bob@home.test" is "admin" of their own household and "member" of the household of "alice@home.test"
    And "bob@home.test" sees exactly gateway "alice-nas" in the household of "alice@home.test"
    And "bob@home.test" sees exactly gateway "bob-nas" without naming a household
    And "alice@home.test" has no pending invites

  Scenario: Accepting twice is a no-op the second time
    Given "alice@home.test" created an invite
    When "bob@home.test" accepts the invite
    And "bob@home.test" accepts the invite
    Then the answer is the household of "alice@home.test"
    And "bob@home.test" is "admin" of their own household and "member" of the household of "alice@home.test"
    When "bob@home.test" previews the invite
    Then the preview says already a member

  Scenario: A used invite doesn't let a second person in
    Given "alice@home.test" created an invite
    When "bob@home.test" accepts the invite
    And "carol@home.test" previews the invite
    Then the invite is refused as not found
    When "carol@home.test" accepts the invite
    Then the invite is refused as not found
    And "carol@home.test" is only in their own household

  Scenario: An expired invite is refused
    Given "alice@home.test" created an invite
    And the invite has expired
    When "bob@home.test" previews the invite
    Then the invite is refused as not found
    When "bob@home.test" accepts the invite
    Then the invite is refused as not found
    And "bob@home.test" is only in their own household
    And "alice@home.test" has no pending invites

  Scenario: A revoked invite is refused
    Given "alice@home.test" created an invite
    And "alice@home.test" lists 1 pending invite
    When "alice@home.test" revokes the invite
    Then "alice@home.test" has no pending invites
    When "bob@home.test" accepts the invite
    Then the invite is refused as not found
    And "bob@home.test" is only in their own household

  Scenario: An unknown token is refused
    When "bob@home.test" accepts the invite token "not-a-real-token"
    Then the invite is refused as not found
    And "bob@home.test" is only in their own household

  Scenario: A member can't create, list or revoke invites
    Given "alice@home.test" created an invite
    And "bob@home.test" accepted it
    When "bob@home.test" creates an invite in the household of "alice@home.test"
    Then the invite is refused as forbidden
    When "bob@home.test" lists invites in the household of "alice@home.test"
    Then the invite is refused as forbidden
    When "bob@home.test" revokes the invite in the household of "alice@home.test"
    Then the invite is refused as forbidden

  Scenario: Another household's invites are invisible
    Given "alice@home.test" created an invite
    Then "bob@home.test" has no pending invites
    When "bob@home.test" revokes the invite in the household of "bob@home.test"
    Then the invite is refused as not found
    When "bob@home.test" lists invites in the household of "alice@home.test"
    Then the invite is refused as not found
    And "alice@home.test" lists 1 pending invite
