using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <inheritdoc />
public partial class Invites : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "invites",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "uuid", nullable: false),
                TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                TokenHash = table.Column<string>(type: "text", nullable: false),
                CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                UsedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_invites", x => x.Id);
                table.ForeignKey(
                    name: "FK_invites_tenants_TenantId",
                    column: x => x.TenantId,
                    principalTable: "tenants",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_invites_users_CreatedBy",
                    column: x => x.CreatedBy,
                    principalTable: "users",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.SetNull);
            });

        migrationBuilder.CreateIndex(
            name: "IX_invites_CreatedBy",
            table: "invites",
            column: "CreatedBy");

        migrationBuilder.CreateIndex(
            name: "IX_invites_TenantId",
            table: "invites",
            column: "TenantId");

        migrationBuilder.CreateIndex(
            name: "IX_invites_TokenHash",
            table: "invites",
            column: "TokenHash",
            unique: true);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(
            name: "invites");
    }
}
