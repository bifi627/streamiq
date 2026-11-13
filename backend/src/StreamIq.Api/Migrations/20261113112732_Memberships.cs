using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// #189: a user can belong to several households. memberships replaces
/// users.TenantId; every existing user becomes admin of their current tenant.
public partial class Memberships : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "memberships",
            columns: table => new
            {
                TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                UserId = table.Column<Guid>(type: "uuid", nullable: false),
                Role = table.Column<string>(type: "text", nullable: false),
                CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_memberships", x => new { x.TenantId, x.UserId });
                table.CheckConstraint("CK_memberships_Role", "\"Role\" IN ('admin', 'member')");
                table.ForeignKey(
                    name: "FK_memberships_tenants_TenantId",
                    column: x => x.TenantId,
                    principalTable: "tenants",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
                table.ForeignKey(
                    name: "FK_memberships_users_UserId",
                    column: x => x.UserId,
                    principalTable: "users",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

        migrationBuilder.CreateIndex(
            name: "IX_memberships_UserId",
            table: "memberships",
            column: "UserId");

        // Backfill before the column goes: the user's household keeps its age.
        migrationBuilder.Sql("""
            INSERT INTO memberships ("TenantId", "UserId", "Role", "CreatedAt")
            SELECT "TenantId", "Id", 'admin', "CreatedAt" FROM users;
            """);

        migrationBuilder.DropForeignKey(
            name: "FK_users_tenants_TenantId",
            table: "users");

        migrationBuilder.DropIndex(
            name: "IX_users_TenantId",
            table: "users");

        migrationBuilder.DropColumn(
            name: "TenantId",
            table: "users");
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        // Each user goes back to their oldest household; one without any is dropped.
        migrationBuilder.AddColumn<Guid>(
            name: "TenantId",
            table: "users",
            type: "uuid",
            nullable: true);

        migrationBuilder.Sql("""
            UPDATE users u SET "TenantId" = (
                SELECT m."TenantId" FROM memberships m WHERE m."UserId" = u."Id"
                ORDER BY m."CreatedAt", m."TenantId" LIMIT 1);
            DELETE FROM users WHERE "TenantId" IS NULL;
            """);

        migrationBuilder.AlterColumn<Guid>(
            name: "TenantId",
            table: "users",
            type: "uuid",
            nullable: false,
            oldClrType: typeof(Guid),
            oldType: "uuid",
            oldNullable: true);

        migrationBuilder.DropTable(
            name: "memberships");

        migrationBuilder.CreateIndex(
            name: "IX_users_TenantId",
            table: "users",
            column: "TenantId");

        migrationBuilder.AddForeignKey(
            name: "FK_users_tenants_TenantId",
            table: "users",
            column: "TenantId",
            principalTable: "tenants",
            principalColumn: "Id",
            onDelete: ReferentialAction.Cascade);
    }
}
