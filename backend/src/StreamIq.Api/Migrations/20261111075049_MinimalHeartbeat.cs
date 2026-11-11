using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <inheritdoc />
/// #140: the heartbeat shrinks to liveness; the status snapshot moves to the
/// gateway API (GET /streamiq/status). Only "update available" stays.
public partial class MinimalHeartbeat : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "Status",
            table: "gateways");

        migrationBuilder.AddColumn<string>(
            name: "Update",
            table: "gateways",
            type: "text",
            nullable: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "Update",
            table: "gateways");

        migrationBuilder.AddColumn<string>(
            name: "Status",
            table: "gateways",
            type: "jsonb",
            nullable: true);
    }
}
