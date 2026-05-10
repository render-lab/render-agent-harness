/**
 * Entry-point: hands the resolved agent to the matching runtime.
 *
 * The exact runtime call depends on `runtimes[].kind` in
 * render-harness.yaml. This template assumes `kind: web`. Edit this
 * file when you change the runtime block.
 */

import { serveAgent } from "@render-harness/runtime-web";
import { agent } from "../agent/index.js";

await serveAgent({ agent });
