import { readFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { EnvVarSpecSchema } from "./schema.js";

const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must match [a-z0-9][a-z0-9-]*");

const npmPackageSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(
    /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    "must be a valid npm package name",
  );

const urlSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//, "must be an http(s) URL");

export const CapabilityFeatureSchema = z.enum([
  "tools",
  "mcpServers",
  "skills",
  "connectors",
  "renderServices",
]);
export type CapabilityFeature = z.infer<typeof CapabilityFeatureSchema>;

export const CapabilityTrustTierSchema = z.enum([
  "official",
  "verified",
  "community",
  "experimental",
]);
export type CapabilityTrustTier = z.infer<typeof CapabilityTrustTierSchema>;

export const CapabilityPermissionProfileSchema = z
  .object({
    accessMode: z.enum(["read", "read_write", "mixed"]).optional(),
    network: z.boolean().optional(),
    filesystem: z.enum(["none", "scoped", "unrestricted"]).optional(),
    sidecarServices: z.boolean().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type CapabilityPermissionProfile = z.infer<typeof CapabilityPermissionProfileSchema>;

export const CapabilityConnectorMetadataSchema = z
  .object({
    key: slugSchema,
    eventTypes: z.array(z.string().min(1).max(100)).max(100).optional(),
    auth: z.enum(["hmac", "token", "oauth", "none", "custom"]),
    description: z.string().min(1).max(280).optional(),
  })
  .strict();
export type CapabilityConnectorMetadata = z.infer<typeof CapabilityConnectorMetadataSchema>;

export const CapabilityQualitySchema = z
  .object({
    testCommand: z.string().min(1).max(200).optional(),
    smokeTestStatus: z.enum(["unknown", "passing", "failing"]).optional(),
    reviewStatus: z.enum(["unreviewed", "automated", "maintainer-reviewed"]).optional(),
  })
  .strict();
export type CapabilityQuality = z.infer<typeof CapabilityQualitySchema>;

export const CapabilityCatalogEntrySchema = z
  .object({
    package: npmPackageSchema,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    categories: z.array(slugSchema).max(20).default([]),
    provider: z.string().min(1).max(80).optional(),
    homepage: urlSchema.optional(),
    repo: urlSchema.optional(),
    docs: urlSchema.optional(),
    license: z.string().min(1).max(64).optional(),
    maintainer: z.string().min(1).max(128).optional(),
    versionRange: z.string().min(1).max(64),
    features: z.array(CapabilityFeatureSchema).min(1).max(5),
    envVars: z.array(EnvVarSpecSchema).default([]),
    permissions: CapabilityPermissionProfileSchema.optional(),
    connectors: z.array(CapabilityConnectorMetadataSchema).default([]),
    quality: CapabilityQualitySchema.optional(),
    trustTier: CapabilityTrustTierSchema.default("community"),
  })
  .strict();
export type CapabilityCatalogEntry = z.infer<typeof CapabilityCatalogEntrySchema>;

export const CapabilityCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilities: z.array(CapabilityCatalogEntrySchema).superRefine((entries, ctx) => {
      const seen = new Map<string, number>();
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry) continue;
        if (seen.has(entry.package)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "package"],
            message: `duplicate capability package "${entry.package}" (first seen at index ${seen.get(
              entry.package,
            )})`,
          });
        } else {
          seen.set(entry.package, i);
        }
      }
    }),
  })
  .strict();
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;

export function parseCapabilityCatalogYaml(yamlText: string): CapabilityCatalog {
  return CapabilityCatalogSchema.parse(parseYaml(yamlText));
}

export function parseCapabilityCatalogJson(jsonText: string): CapabilityCatalog {
  return CapabilityCatalogSchema.parse(JSON.parse(jsonText));
}

export async function loadCapabilityCatalog(path: string): Promise<CapabilityCatalog> {
  const text = await readFile(path, "utf8");
  return path.endsWith(".json")
    ? parseCapabilityCatalogJson(text)
    : parseCapabilityCatalogYaml(text);
}

export function serializeCapabilityCatalog(catalog: CapabilityCatalog): string {
  return stringifyYaml(catalog, {
    lineWidth: 100,
    minContentWidth: 40,
    aliasDuplicateObjects: false,
  });
}
