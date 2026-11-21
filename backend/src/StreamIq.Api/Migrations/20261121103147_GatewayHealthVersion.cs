using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <summary>gateway_health.GatewayVersion: the heartbeat's gateway version per row; older rows stay null.</summary>
public partial class GatewayHealthVersion : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "GatewayVersion",
            table: "gateway_health",
            type: "text",
            nullable: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "GatewayVersion",
            table: "gateway_health");
    }
}
