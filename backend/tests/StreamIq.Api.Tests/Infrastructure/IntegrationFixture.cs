using System.IO;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using StreamIq.Api.Data;
using Testcontainers.PostgreSql;

namespace StreamIq.Api.Tests.Infrastructure;

/// One Postgres + one Firebase Auth emulator shared across the WHOLE test
/// assembly — both the xUnit `[Collection("integration")]` tests and Reqnroll's
/// `[ScenarioDependencies]` (see Infrastructure/ScenarioDeps.cs) construct their own
/// `IntegrationFixture` instance, but every instance wraps the same lazily-started
/// process-global `SharedContainers`. That keeps FIREBASE_AUTH_EMULATOR_HOST at one
/// stable value for the whole run — a second emulator would fight the first over
/// that process-global env var and real tokens minted from one would fail
/// verification when it points at the other. Reuses the prebuilt emulator image
/// (dev/firebase/Dockerfile) so boot pulls nothing from npm — deterministic start.
public sealed class IntegrationFixture : IAsyncLifetime
{
    private static readonly Lazy<Task<SharedContainers>> Shared = new(SharedContainers.StartAsync);

    // ! assigned in InitializeAsync, which xUnit runs before any test
    private SharedContainers _shared = default!;

    public StreamIqApiFactory Factory => _shared.Factory;
    public string EmulatorHost => _shared.EmulatorHost;

    public async Task InitializeAsync()
    {
        _shared = await Shared.Value;
    }

    // No-op: the shared containers live for the whole process (started at most
    // once via the Lazy above) since more than one owner (xUnit's collection
    // fixture, Reqnroll's ScenarioDeps) holds an IntegrationFixture pointing at
    // them. Testcontainers' Ryuk sidecar reaps the containers when the process
    // exits, so nothing leaks.
    public Task DisposeAsync()
    {
        return Task.CompletedTask;
    }

    /// Per-test reset: truncate all tenant data (lazy, no Respawn dependency).
    public Task ResetAsync()
    {
        return _shared.ResetAsync();
    }

    private sealed class SharedContainers(PostgreSqlContainer pg, IContainer firebase, StreamIqApiFactory factory, string emulatorHost)
    {
        // Rooted for the life of the process (never disposed — see IntegrationFixture.DisposeAsync)
        // so the underlying Docker containers stay up until Ryuk reaps them at process exit.
        private readonly PostgreSqlContainer _pg = pg;
        private readonly IContainer _firebase = firebase;

        public StreamIqApiFactory Factory { get; } = factory;
        public string EmulatorHost { get; } = emulatorHost;

        public static async Task<SharedContainers> StartAsync()
        {
            // Prebuilt (dev/firebase/Dockerfile) so firebase-tools is baked into the
            // image, not npx-pulled at container start — the npm fetch moves into the
            // build step (Docker-layer cached) and boot becomes deterministic.
            var firebaseImage = new ImageFromDockerfileBuilder()
                .WithDockerfileDirectory(new CommonDirectoryPath(Path.Combine(RepoRoot.Find(), "dev", "firebase")), string.Empty)
                .WithDockerfile("Dockerfile")
                // No WithName: the default random tag is per run. A fixed tag is shared by every
                // worktree, and each run's resource reaper deletes "its" image at the end, which
                // untags it under a concurrent run ("image has not been created"). Layers stay cached.
                .Build();
            await firebaseImage.CreateAsync();

            var pg = new PostgreSqlBuilder("postgres:18").Build();
            var firebase = new ContainerBuilder(firebaseImage)
                .WithResourceMapping(
                    new FileInfo(Path.Combine(RepoRoot.Find(), "dev", "firebase", "firebase.json")),
                    "/app/")
                .WithWorkingDirectory("/app")
                .WithCommand("firebase", "emulators:start", "--only", "auth", "--project", "demo-streamiq")
                .WithPortBinding(9099, true)
                .WithWaitStrategy(Wait.ForUnixContainer().UntilMessageIsLogged("All emulators ready"))
                .Build();

            await Task.WhenAll(pg.StartAsync(), firebase.StartAsync());
            var emulatorHost = $"{firebase.Hostname}:{firebase.GetMappedPublicPort(9099)}";
            var factory = new StreamIqApiFactory(pg.GetConnectionString(), emulatorHost);

            // Force host build + apply migrations before any test runs.
            using (var scope = factory.Services.CreateScope())
            {
                await scope.ServiceProvider.GetRequiredService<StreamIqDbContext>().Database.MigrateAsync();
            }

            return new SharedContainers(pg, firebase, factory, emulatorHost);
        }

        public async Task ResetAsync()
        {
            using var scope = Factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<StreamIqDbContext>();
            await db.Database.ExecuteSqlRawAsync(
                "TRUNCATE gateways, users, tenants RESTART IDENTITY CASCADE;");
        }
    }
}

[CollectionDefinition("integration")]
public sealed class IntegrationCollection : ICollectionFixture<IntegrationFixture>;
