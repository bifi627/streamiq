using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <summary>gateway_health (the box's health at `full` telemetry, a row on change and every 5 min) + gateways.Telemetry (the heartbeat's level; null = too old to send one).</summary>
public partial class GatewayHealth : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "Telemetry",
            table: "gateways",
            type: "text",
            nullable: true);

        migrationBuilder.CreateTable(
            name: "gateway_health",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "uuid", nullable: false),
                TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                GatewayId = table.Column<Guid>(type: "uuid", nullable: false),
                At = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                Level = table.Column<string>(type: "text", nullable: false),
                JellyfinReachable = table.Column<bool>(type: "boolean", nullable: true),
                JellyfinVersion = table.Column<string>(type: "text", nullable: true),
                Os = table.Column<string>(type: "text", nullable: true),
                Arch = table.Column<string>(type: "text", nullable: true),
                Transcoding = table.Column<string>(type: "text", nullable: true),
                Offline = table.Column<string>(type: "text", nullable: true),
                Tunnels = table.Column<int>(type: "integer", nullable: true),
                Transcodes = table.Column<int>(type: "integer", nullable: true),
                Cpu = table.Column<double>(type: "double precision", nullable: true),
                Memory = table.Column<double>(type: "double precision", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_gateway_health", x => x.Id);
                table.ForeignKey(
                    name: "FK_gateway_health_gateways_GatewayId",
                    column: x => x.GatewayId,
                    principalTable: "gateways",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_gateway_health_tenants_TenantId",
                    column: x => x.TenantId,
                    principalTable: "tenants",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_gateway_health_GatewayId_At",
            table: "gateway_health",
            columns: new[] { "GatewayId", "At" });

        migrationBuilder.CreateIndex(
            name: "IX_gateway_health_TenantId",
            table: "gateway_health",
            column: "TenantId");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "gateway_health");

        migrationBuilder.DropColumn(
            name: "Telemetry",
            table: "gateways");
    }
}
