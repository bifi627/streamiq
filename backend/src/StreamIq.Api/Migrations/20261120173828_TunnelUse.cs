using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <summary>tunnels.Use + ActiveMs (#681): what the tunnel was for and how long it was active, from the gateway's report; null for older gateways and unreported rows.</summary>
public partial class TunnelUse : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<long>(
            name: "ActiveMs",
            table: "tunnels",
            type: "bigint",
            nullable: true);

        migrationBuilder.AddColumn<string>(
            name: "Use",
            table: "tunnels",
            type: "text",
            nullable: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "ActiveMs",
            table: "tunnels");

        migrationBuilder.DropColumn(
            name: "Use",
            table: "tunnels");
    }
}
