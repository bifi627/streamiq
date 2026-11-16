using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <summary>
/// connection_sessions → tunnels (#389): a rename that keeps the rows. EF scaffolds
/// drop + create for a table rename, so this is hand-written; the constraint and
/// index names follow so the model matches what EF would have created.
/// </summary>
public partial class Tunnels : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        Rename(migrationBuilder, "connection_sessions", "tunnels");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        Rename(migrationBuilder, "tunnels", "connection_sessions");
    }

    private static void Rename(MigrationBuilder mb, string from, string to)
    {
        mb.RenameTable(name: from, newName: to);
        mb.Sql($"""
            ALTER TABLE {to} RENAME CONSTRAINT "PK_{from}" TO "PK_{to}";
            ALTER TABLE {to} RENAME CONSTRAINT "FK_{from}_gateways_GatewayId" TO "FK_{to}_gateways_GatewayId";
            ALTER TABLE {to} RENAME CONSTRAINT "FK_{from}_tenants_TenantId" TO "FK_{to}_tenants_TenantId";
            """);
        mb.RenameIndex(name: $"IX_{from}_GatewayId", table: to, newName: $"IX_{to}_GatewayId");
        mb.RenameIndex(name: $"IX_{from}_TenantId", table: to, newName: $"IX_{to}_TenantId");
    }
}
