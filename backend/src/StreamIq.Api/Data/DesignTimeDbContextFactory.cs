using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace StreamIq.Api.Data;

/// For dotnet-ef, without the app's startup. `migrations add` never opens a
/// connection, so the connection string only has to parse.
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<StreamIqDbContext>
{
    public StreamIqDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<StreamIqDbContext>()
            .UseNpgsql("Host=localhost;Port=5432;Username=streamiq;Password=dev;Database=streamiq")
            .Options;
        return new StreamIqDbContext(options);
    }
}
