using Microsoft.EntityFrameworkCore;

namespace StreamIq.Api.Data;

public class StreamIqDbContext(DbContextOptions<StreamIqDbContext> options) : DbContext(options)
{
    /// Set per request from a membership of the signed-in user (Auth/Households),
    /// never from client input directly. Null in
    /// unauthenticated contexts ⇒ the filter matches nothing ⇒ fails closed.
    public Guid? CurrentTenantId { get; set; }

    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<AppUser> Users => Set<AppUser>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<Gateway> Gateways => Set<Gateway>();
    public DbSet<EnrollmentToken> EnrollmentTokens => Set<EnrollmentToken>();
    public DbSet<Invite> Invites => Set<Invite>();
    public DbSet<Tunnel> Tunnels => Set<Tunnel>();
    public DbSet<GatewayHealth> GatewayHealth => Set<GatewayHealth>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Tenant>(e =>
        {
            e.ToTable("tenants");
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<AppUser>(e =>
        {
            e.ToTable("users");
            e.HasIndex(x => x.FirebaseUid).IsUnique();
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<Membership>(e =>
        {
            e.ToTable("memberships", t => t.HasCheckConstraint("CK_memberships_Role", "\"Role\" IN ('admin', 'member')"));
            e.HasKey(x => new { x.TenantId, x.UserId });
            e.HasIndex(x => x.UserId);
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<Gateway>(e =>
        {
            e.ToTable("gateways");
            e.HasIndex(x => x.CredentialHash).IsUnique();
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<EnrollmentToken>(e =>
        {
            e.ToTable("enrollment_tokens");
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<Invite>(e =>
        {
            e.ToTable("invites");
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<Tunnel>(e =>
        {
            e.ToTable("tunnels");
            e.Property(x => x.CreatedAt).HasDefaultValueSql("now()").ValueGeneratedOnAdd();
        });

        b.Entity<GatewayHealth>(e =>
        {
            e.ToTable("gateway_health");
            e.HasIndex(x => new { x.GatewayId, x.At });
        });

        // No navigation properties: entities stay plain scalars.
        b.Entity<Membership>().HasOne<Tenant>().WithMany().HasForeignKey(m => m.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Membership>().HasOne<AppUser>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Gateway>().HasOne<Tenant>().WithMany().HasForeignKey(d => d.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<EnrollmentToken>().HasOne<Tenant>().WithMany().HasForeignKey(t => t.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Invite>().HasOne<Tenant>().WithMany().HasForeignKey(i => i.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Invite>().HasOne<AppUser>().WithMany().HasForeignKey(i => i.CreatedBy).OnDelete(DeleteBehavior.SetNull);
        b.Entity<Tunnel>().HasOne<Tenant>().WithMany().HasForeignKey(c => c.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Tunnel>().HasOne<Gateway>().WithMany().HasForeignKey(c => c.GatewayId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<GatewayHealth>().HasOne<Tenant>().WithMany().HasForeignKey(h => h.TenantId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<GatewayHealth>().HasOne<Gateway>().WithMany().HasForeignKey(h => h.GatewayId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<Tunnel>().HasOne<AppUser>().WithMany().HasForeignKey(c => c.UserId).OnDelete(DeleteBehavior.SetNull);   // the telemetry outlives the account

        // A generic lambda on the instance property: EF reads CurrentTenantId per query,
        // not once at model build.
        foreach (var et in b.Model.GetEntityTypes()
                     .Where(t => typeof(ITenantOwned).IsAssignableFrom(t.ClrType)))
        {
            // ! nameof() guarantees the method exists on this class
            typeof(StreamIqDbContext)
                .GetMethod(nameof(ApplyTenantFilter),
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
                .MakeGenericMethod(et.ClrType)
                .Invoke(this, [b]);
        }
    }

    private void ApplyTenantFilter<T>(ModelBuilder b) where T : class, ITenantOwned
    {
        b.Entity<T>().HasQueryFilter(e => e.TenantId == CurrentTenantId);
    }
}
