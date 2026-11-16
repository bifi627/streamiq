Feature: Members
  Any member sees who is in the household: their alias from Firebase (never
  stored; the email for an account without one), role and joined date. Your own
  email is on your row only, never on anyone else's (#388). An admin removes members and promotes or demotes;
  anyone can leave. Nothing may leave a household without an admin. A membership
  that is gone ends access on the next request. Only the request's household is
  ever touched (tenant isolation, crown jewel).

  Background:
    Given "bob@home.test" is a member of the household of "alice@home.test"

  Scenario: A member lists the household's members with names from Firebase
    When "bob@home.test" lists the members of the household of "alice@home.test"
    Then the members are "alice@home.test" as "admin" and "bob@home.test" as "member"

  Scenario: Aliases replace emails; each member gets only their own email
    Given "erin@home.test" is a member of the household of "alice@home.test"
    And "erin@home.test" picked the alias "Erin"
    When "alice@home.test" lists the members of the household of "alice@home.test"
    Then the members are "alice@home.test" as "admin" and "bob@home.test" as "member" and "Erin" as "member"
    And the only email listed is "alice@home.test"
    When "erin@home.test" lists the members of the household of "alice@home.test"
    Then the members are "alice@home.test" as "admin" and "bob@home.test" as "member" and "Erin" as "member"
    And the only email listed is "erin@home.test"

  Scenario: An admin removes a member, who then gets 404 there
    When "alice@home.test" removes "bob@home.test" from the household of "alice@home.test"
    Then the answer is 204
    When "bob@home.test" lists the members of the household of "alice@home.test"
    Then the answer is 404
    When "alice@home.test" lists the members of the household of "alice@home.test"
    Then the members are "alice@home.test" as "admin"
    And "bob@home.test" still has their own household, not the one of "alice@home.test"

  Scenario: A member leaves, then gets 404 there
    When "bob@home.test" removes "bob@home.test" from the household of "alice@home.test"
    Then the answer is 204
    When "bob@home.test" lists the members of the household of "alice@home.test"
    Then the answer is 404

  Scenario: A member can't remove anyone else or change roles
    When "bob@home.test" removes "alice@home.test" from the household of "alice@home.test"
    Then the answer is 403
    When "bob@home.test" makes "bob@home.test" "admin" in the household of "alice@home.test"
    Then the answer is 403
    When "alice@home.test" lists the members of the household of "alice@home.test"
    Then the members are "alice@home.test" as "admin" and "bob@home.test" as "member"

  Scenario: An admin promotes and demotes; the role applies on the next request
    When "alice@home.test" makes "bob@home.test" "admin" in the household of "alice@home.test"
    Then the answer is 204
    When "bob@home.test" opens the invites of the household of "alice@home.test"
    Then the answer is 200
    When "bob@home.test" makes "alice@home.test" "member" in the household of "alice@home.test"
    Then the answer is 204
    When "alice@home.test" opens the invites of the household of "alice@home.test"
    Then the answer is 403
    When "bob@home.test" lists the members of the household of "alice@home.test"
    Then the members are "alice@home.test" as "member" and "bob@home.test" as "admin"

  Scenario: Removing an admin also deletes their pending invites; demoting keeps them
    Given "alice@home.test" made "bob@home.test" "admin" in the household of "alice@home.test"
    And "bob@home.test" created an invite in the household of "alice@home.test"
    When "alice@home.test" makes "bob@home.test" "member" in the household of "alice@home.test"
    Then the household of "alice@home.test" has 1 pending invite
    When "alice@home.test" removes "bob@home.test" from the household of "alice@home.test"
    Then the household of "alice@home.test" has 0 pending invites

  Scenario: The last admin can't leave or demote themselves
    When "alice@home.test" removes "alice@home.test" from the household of "alice@home.test"
    Then the answer is 409 saying "at least one admin"
    When "alice@home.test" makes "alice@home.test" "member" in the household of "alice@home.test"
    Then the answer is 409 saying "at least one admin"
    When "alice@home.test" makes "bob@home.test" "admin" in the household of "alice@home.test"
    And "alice@home.test" removes "alice@home.test" from the household of "alice@home.test"
    Then the answer is 204

  Scenario: Two admins demoting each other at once leaves one admin
    Given "alice@home.test" made "bob@home.test" "admin" in the household of "alice@home.test"
    When "alice@home.test" and "bob@home.test" demote each other at once in the household of "alice@home.test"
    Then exactly one demotion succeeds and the household keeps one admin

  Scenario: Another household's members are out of reach
    Given "carol@home.test" is a member of the household of "dave@home.test"
    When "alice@home.test" removes "carol@home.test" from the household of "alice@home.test"
    Then the answer is 404
    When "alice@home.test" makes "carol@home.test" "admin" in the household of "alice@home.test"
    Then the answer is 404
    When "dave@home.test" lists the members of the household of "dave@home.test"
    Then the members are "dave@home.test" as "admin" and "carol@home.test" as "member"

  Scenario: Leaving the last household makes a new one on the next request
    Given "alice@home.test" is an admin of the household of "bob@home.test"
    When "bob@home.test" removes "bob@home.test" from the household of "bob@home.test"
    Then the answer is 204
    When "bob@home.test" removes "bob@home.test" from the household of "alice@home.test"
    Then the answer is 204
    And "bob@home.test" is admin of exactly one new household

  Scenario: An admin names the household; members see the name, can't change it
    When "alice@home.test" names the household of "alice@home.test" "  The Smiths  "
    Then the answer is 200
    And "bob@home.test" sees the household of "alice@home.test" named "The Smiths"
    When "bob@home.test" names the household of "alice@home.test" "Bob's"
    Then the answer is 403
    And "alice@home.test" sees the household of "alice@home.test" named "The Smiths"

  Scenario: A household name is required and at most 100 characters
    When "alice@home.test" names the household of "alice@home.test" "   "
    Then the answer is 400
    When "alice@home.test" names the household of "alice@home.test" a 101-character name
    Then the answer is 400
    When "alice@home.test" names the household of "alice@home.test" a 100-character name
    Then the answer is 200

  Scenario: Another household can't be named
    When "alice@home.test" names the household of "dave@home.test" "Mine now"
    Then the answer is 404
    And "dave@home.test" sees the household of "dave@home.test" unnamed
