# @dino/plugins

API discovery and auth adapter plugins for Project Dino. Tenant-agnostic; no Circo or environment references. All dependencies are injected via options.

## Discovery plugin interface

A **discovery plugin** returns operations from a live API (e.g. GraphQL introspection). Implement `DiscoveryPlugin`:

- `id: string` — stable plugin identifier (e.g. `'graphql'`)
- `discover(options: DiscoveryOptions): Promise<DiscoveryResult>` — all inputs (endpoint, timeout, headers, logger) come from options

`DiscoveryResult` contains `operations: Operation[]` (from `@dino/core`) and optional `raw` for plugin-specific payloads (e.g. full introspection for tools that need inputTypes/enumTypes).

## GraphQL discovery plugin

The GraphQL plugin wraps an introspection engine behind the plugin interface. The introspect function is **injected** (DI); the host provides it (e.g. from `src/introspection/introspect` with tenant-derived config).

**Wiring from the root app (tenant-agnostic):**

```ts
import { createGraphQLDiscoveryPlugin } from '@dino/plugins';
import { introspect } from '../src/introspection'; // or path to your introspect

const plugin = createGraphQLDiscoveryPlugin({
  introspect: (opts) => introspect({ endpoint: opts.endpoint, timeout: opts.timeout, headers: opts.headers }),
});

const result = await plugin.discover({
  endpoint: tenant.environments[envName].endpoints['main-api'],
  timeout: tenant.environments[envName].timeout,
  headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
});
// result.operations → Operation[] for AgentContext
// result.raw → full IntrospectionResult when needed
```

The root `introspect()` accepts `IntrospectOptions` (`endpoint`, `timeout?`, `headers?`) so it can be called without `getEnvironment()`.
