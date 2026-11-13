Feature: First sign-in provisioning
  A new Firebase identity gets exactly one tenant (household) and one user, its admin.

  Scenario: First sign-in creates one tenant and one user
    When a new user "fresh@home.test" signs in
    Then there is exactly 1 tenant and 1 user
    And that user is the admin of that tenant
