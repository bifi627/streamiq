Feature: Auth rejection
  Endpoints require a valid Firebase ID token.

  Scenario: Missing token is rejected
    When an anonymous request hits "/api/me"
    Then the response status is 401

  Scenario: Invalid token is rejected
    When a request with token "garbage" hits "/api/me"
    Then the response status is 401
