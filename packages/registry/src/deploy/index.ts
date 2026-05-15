/**
 * `render-harness deploy` — orchestrates the full provision-to-Render
 * flow. Reads `render-harness.yaml`, emits the Blueprint, plans every
 * resource (databases, services, workflow), and creates each via the
 * Render REST API. Idempotent across re-runs via a lock file.
 *
 *   import { deploy } from "@render-harness/registry/deploy";
 *   await deploy({ projectRoot, apiKey });
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { emitBlueprint } from "../emitter.js";
import { loadPacks } from "../load-pack.js";
import { type HarnessConfig, parseHarnessConfigYaml } from "../schema.js";
import { RenderApi } from "./api.js";
import { discoverContext } from "./discover.js";
import { executePlan, type ExecutorResult } from "./executor.js";
import { readLock } from "./lock.js";
import { planFromBlueprint } from "./planner.js";

export interface DeployOpts {
  /** Repo root containing render-harness.yaml. Defaults to process.cwd(). */
  projectRoot?: string;
  /** RENDER_API_KEY override. Defaults to env. */
  apiKey?: string;
  /** Owner id override. Falls back to env (RENDER_OWNER_ID) then auto-discovery. */
  ownerId?: string;
  /** Repo URL override. Falls back to `git remote get-url origin`. */
  repo?: string;
  /** Git branch override. Falls back to current HEAD's branch. */
  branch?: string;
  /** Workspace-package name to thread through build commands. */
  packageName?: string;
  /** Render region for resources missing an explicit region. */
  region?: string;
  /** When true, print the plan but make no API calls. */
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface DeployResult extends ExecutorResult {
  /** Final config used for the deploy. */
  config: HarnessConfig;
}

export async function deploy(opts: DeployOpts = {}): Promise<DeployResult> {
  const env = opts.env ?? process.env;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const apiKey = opts.apiKey ?? env.RENDER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "deploy: RENDER_API_KEY env var (or --api-key flag) is required",
    );
  }

  // 1. Load + validate manifest
  const yamlText = await readFile(resolve(projectRoot, "render-harness.yaml"), "utf8");
  const config = parseHarnessConfigYaml(yamlText);
  const packageName = opts.packageName ?? `@render-harness/example-${config.name}`;
  const region = opts.region ?? "oregon";

  // 2. Build the Render API client + discover context
  const api = new RenderApi({ apiKey });
  const ctx = await discoverContext({
    projectRoot,
    api,
    ...(opts.repo !== undefined ? { repoOverride: opts.repo } : {}),
    ...(opts.branch !== undefined ? { branchOverride: opts.branch } : {}),
    ...(opts.ownerId !== undefined ? { ownerIdOverride: opts.ownerId } : {}),
    env,
  });

  log(`▸ Workspace: ${ctx.ownerId}`);
  log(`▸ Repo:      ${ctx.repoUrl}`);
  log(`▸ Branch:    ${ctx.branch}`);

  // 3. Emit the Blueprint (single source of truth for what gets deployed)
  const packs = await loadPacks(
    config.capabilities ? { entryRoot: projectRoot, refs: config.capabilities } : { entryRoot: projectRoot },
  );
  const { blueprint, dashboardSteps } = await emitBlueprint({
    config,
    packs,
    packageName,
    region,
    env,
  });

  // 4. Plan + read existing lock
  const plan = planFromBlueprint({
    blueprint,
    config,
    ownerId: ctx.ownerId,
    repoUrl: ctx.repoUrl,
    branch: ctx.branch,
    packageName,
    region,
  });
  const existingLock = await readLock(projectRoot);

  log("");
  log(`▸ Plan: ${plan.resources.length} resource${plan.resources.length === 1 ? "" : "s"}`);
  if (dashboardSteps.length > 0 && opts.dryRun) {
    log("  (dashboard steps in the emitter's output have been folded into API calls)");
  }

  // 5. Execute
  const result = await executePlan({
    api,
    plan,
    projectRoot,
    ownerId: ctx.ownerId,
    existingLock,
    ...(opts.dryRun ? { dryRun: true } : {}),
    log,
  });

  log("");
  if (opts.dryRun) {
    log(`▸ Dry-run complete — would create ${result.created.length}, skip ${result.skipped.length}.`);
  } else {
    log(`▸ Deploy complete — created ${result.created.length}, skipped ${result.skipped.length}.`);
    log(`▸ Lock file: ${projectRoot}/.render-deploy.lock.json`);
    log("");
    log("Next steps:");
    log("  - Open the Render dashboard for this workspace to fill in any sync:false secrets.");
    log("  - Wait ~2-5 minutes for the first deploys to finish, then hit the web service URL.");
  }

  return { ...result, config };
}
