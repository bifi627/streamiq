Feature: Gateway health
  The heartbeat carries the gateway's telemetry level, and at `full` the box's health
  (#423). The API keeps the level on the gateway and a `gateway_health` row when the
  health changes or the latest row is 5 minutes old, never two rows within 25 seconds.
  `off` stores nothing new and keeps the rows. Rows are tenant-owned (the global filter).

  Scenario: A full heartbeat stores the level and a health row, listed for every member
    Given "alice@home.test" has an online gateway "nas"
    And "bob@home.test" is a member of the household of "alice@home.test"
    When gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 1 tunnels
    Then gateway "nas" has telemetry "full"
    And gateway "nas" has 1 health rows
    And the latest health row of gateway "nas" has Jellyfin "10.11.2" and 1 tunnels
    And "bob@home.test" sees gateway "nas" with telemetry "full"

  Scenario: Only a change makes a new row, not the live counts
    Given "alice@home.test" has an online gateway "nas"
    When gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 1 tunnels
    And gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 3 tunnels
    Then gateway "nas" has 1 health rows
    When the latest health row of gateway "nas" is 25 seconds old
    And gateway "nas" sends a full heartbeat with Jellyfin "10.11.3" and 3 tunnels
    Then gateway "nas" has 2 health rows
    And the latest health row of gateway "nas" has Jellyfin "10.11.3" and 3 tunnels

  # The heartbeat comes every 30 s: a gateway flipping a field on every message adds no more.
  Scenario: A change within 25 seconds of the latest row waits for the next heartbeat
    Given "alice@home.test" has an online gateway "nas"
    When gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 1 tunnels
    And gateway "nas" sends a full heartbeat with Jellyfin "10.11.3" and 1 tunnels
    And gateway "nas" sends a full heartbeat with Jellyfin "10.11.4" and 1 tunnels
    Then gateway "nas" has 1 health rows
    And the latest health row of gateway "nas" has Jellyfin "10.11.2" and 1 tunnels

  Scenario: An unchanged box still gets a row every 5 minutes
    Given "alice@home.test" has an online gateway "nas"
    When gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 1 tunnels
    Then gateway "nas" has 1 health rows
    When the latest health row of gateway "nas" is 5 minutes old
    And gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 2 tunnels
    Then gateway "nas" has 2 health rows
    And the latest health row of gateway "nas" has Jellyfin "10.11.2" and 2 tunnels

  Scenario Outline: Off or an unknown level stores nothing new and keeps the rows
    Given "alice@home.test" has an online gateway "nas"
    When gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 1 tunnels
    Then gateway "nas" has 1 health rows
    When gateway "nas" sends a heartbeat at level "<level>" with Jellyfin "10.11.3"
    Then gateway "nas" has telemetry "off"
    And gateway "nas" has 1 health rows

    Examples:
      | level |
      | off   |
      | basic |

  Scenario: A gateway too old to send a level has none and stores nothing
    Given "alice@home.test" has an online gateway "nas"
    When gateway "nas" sends a heartbeat
    Then gateway "nas" has no telemetry level
    And "alice@home.test" sees gateway "nas" with no telemetry level
    And gateway "nas" has 0 health rows

  # The tenant filter itself, not the gateway id: a row of another household naming this
  # gateway (impossible in practice) is never read (an equal one would stop the insert)
  # nor deleted.
  Scenario: Another household's health rows are never read or deleted
    Given "alice@home.test" has an online gateway "nas"
    And the household of "eve@home.test" has a health row for gateway "nas" with Jellyfin "10.11.2"
    When gateway "nas" sends a full heartbeat with Jellyfin "10.11.2" and 1 tunnels
    Then gateway "nas" has 2 health rows
    When gateway "nas" sends a heartbeat at level "off" with Jellyfin "10.11.2"
    Then gateway "nas" has telemetry "off"
    And gateway "nas" has 2 health rows
    And the household of "eve@home.test" still has its health row
