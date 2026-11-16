Feature: First sign-in provisioning
  A new Firebase identity gets exactly one user and no household (#387): a user joins
  one through an invite or creates one on purpose.

  Scenario: First sign-in creates one user and no household
    When a new user "fresh@home.test" signs in
    Then there is exactly 0 tenant and 1 user
    And that user is in no household

  Scenario: Creating a household makes the user its admin
    When a new user "fresh@home.test" signs in
    And "fresh@home.test" creates a household
    Then there is exactly 1 tenant and 1 user
    And that user is the admin of that tenant
