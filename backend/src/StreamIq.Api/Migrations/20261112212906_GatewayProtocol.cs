using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// #176: the gateway protocol from the last heartbeat (also a refused one), so the
/// Gateways list can say "update required".
public partial class GatewayProtocol : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<int>(
            name: "Protocol",
            table: "gateways",
            type: "integer",
            nullable: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "Protocol",
            table: "gateways");
    }
}
