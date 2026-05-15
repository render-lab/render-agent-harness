import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    react(),
    starlight({
      title: "Render Harness Docs",
      description: "Interactive architecture docs for the Render agent harness.",
      customCss: ["./src/styles/theme.css"],
      expressiveCode: {
        themes: ["github-dark-default"],
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "" },
            { label: "Ways to use", slug: "ways-to-use" },
            { label: "Architecture graph", slug: "architecture" },
            { label: "Local development", slug: "local-development" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Core loop", slug: "core-loop" },
            { label: "Runtime paths", slug: "runtime-paths" },
            { label: "Package map", slug: "package-map" },
            { label: "Registry and scaffolding", slug: "registry-and-scaffolding" },
            { label: "Template catalog", slug: "template-catalog" },
            { label: "Chief of Staff bundle", slug: "chief-of-staff" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "render-harness.yaml spec", slug: "yaml-spec" },
            { label: "Deployment model", slug: "deployment" },
            { label: "Web API", slug: "web-api" },
            { label: "Operator UI", slug: "operator-ui" },
            { label: "Capabilities", slug: "capabilities" },
            { label: "Built-in tools", slug: "built-in-tools" },
            { label: "State and streaming", slug: "state-and-streaming" },
            { label: "Examples and Blueprints", slug: "examples-and-blueprints" },
            { label: "Operations", slug: "operations" },
          ],
        },
      ],
    }),
  ],
});
