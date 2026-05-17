import pkg from "../package.json" with { type: "json" };

const registryRange = pkg.dependencies["@render-harness/registry"];

export const DEFAULT_HARNESS_VERSION_RANGE =
  typeof registryRange === "string" && registryRange !== "workspace:*" ? registryRange : "^0.1.1";
