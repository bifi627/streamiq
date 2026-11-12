using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <inheritdoc />
/// #162: the client's measured gateway → client throughput, sent with the end PATCH.
public partial class ConnectionThroughput : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<int>(
            name: "ThroughputKbps",
            table: "connection_sessions",
            type: "integer",
            nullable: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "ThroughputKbps",
            table: "connection_sessions");
    }
}
