import type { Answers } from "../types.js";

/**
 * `docker-compose.yml` for the scaffolded project. Brings up the two
 * datastores the harness needs — Postgres (state, queue, pub/sub) and
 * Valkey (cancellation signals) — matching the versions/conventions of
 * Render Managed Postgres + Render Key Value.
 *
 * Container names are namespaced by agent name so multiple scaffolds can
 * run side-by-side without collision. Ports default to 55432 / 56379
 * (same as the harness compose) and are overridable via env vars.
 */
export function dockerCompose(answers: Answers): string {
  const name = answers.agentName;
  return `name: ${name}

# Local datastore stack for ${name}. Versions match Render Managed Postgres
# and Render Key Value. Bound to 127.0.0.1 only.
#
#   pnpm db:up      bring the stack up (waits for healthy)
#   pnpm db:down    stop the stack (data preserved in the named volume)
#   pnpm db:reset   nuke volumes and restart
#   pnpm db:logs    tail logs
#
# Port overrides if 55432 / 56379 are taken on your host:
#   PG_PORT=15432 KV_PORT=16379 pnpm db:up

services:
  postgres:
    image: postgres:17-alpine
    container_name: ${name}-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: harness
      POSTGRES_PASSWORD: harness
      POSTGRES_DB: harness
    ports:
      - "127.0.0.1:\${PG_PORT:-55432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harness -d harness"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s

  valkey:
    image: valkey/valkey:8-alpine
    container_name: ${name}-valkey
    restart: unless-stopped
    command: ["valkey-server", "--save", "", "--appendonly", "no"]
    ports:
      - "127.0.0.1:\${KV_PORT:-56379}:6379"
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 2s

volumes:
  pgdata:
`;
}
