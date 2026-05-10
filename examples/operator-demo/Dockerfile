# Self-contained image for the operator-demo example. Builds the
# minimal slice of the workspace needed to run the web service AND the
# worker — they share the same compiled output, the compose file just
# runs them with different commands.
#
# Build context: the repo root. See `examples/operator-demo/.dockerignore`
# for what we exclude.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Copy the workspace plumbing first so dependency-graph layer caches
# even when only source changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./

# Workspace package manifests (without source) so pnpm can resolve the
# dependency graph for `--filter` without needing the implementations yet.
COPY packages packages
COPY examples/operator-demo examples/operator-demo

# Install only the deps the operator-demo example actually needs (its
# transitive workspace deps + their npm deps). `--frozen-lockfile` keeps
# image builds reproducible.
RUN pnpm install \
    --filter @render-harness/example-operator-demo... \
    --frozen-lockfile

# Build the operator-demo and every workspace package it depends on.
# `...` means "include dependencies".
RUN pnpm --filter @render-harness/example-operator-demo... run build

# --------------------------------------------------------------------
# Runtime image: same node base, stripped of build tooling. We keep it
# simple — node_modules are reused via pnpm's symlink layout, so we
# can't easily prune dev-only deps without breaking links. For a demo
# image the size cost is acceptable.
# --------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

COPY --from=build /app /app

EXPOSE 8082
# Default command runs the web service. The compose worker overrides
# this with `dist/worker.js`.
CMD ["node", "examples/operator-demo/dist/web.js"]
