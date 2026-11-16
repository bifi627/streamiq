using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace StreamIq.Api.Migrations;

/// <summary>tunnels.UserId (#390): who opened the tunnel, written by the broker.</summary>
public partial class TunnelUser : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<Guid>(
            name: "UserId",
            table: "tunnels",
            type: "uuid",
            nullable: true);

        migrationBuilder.CreateIndex(
            name: "IX_tunnels_UserId",
            table: "tunnels",
            column: "UserId");

        migrationBuilder.AddForeignKey(
            name: "FK_tunnels_users_UserId",
            table: "tunnels",
            column: "UserId",
            principalTable: "users",
            principalColumn: "Id",
            onDelete: ReferentialAction.Cascade);
    }

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropForeignKey(
            name: "FK_tunnels_users_UserId",
            table: "tunnels");

        migrationBuilder.DropIndex(
            name: "IX_tunnels_UserId",
            table: "tunnels");

        migrationBuilder.DropColumn(
            name: "UserId",
            table: "tunnels");
    }
}
