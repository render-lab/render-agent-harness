import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";

export default defineConfig({
  integrations: [
    react(),
    mermaid({
      theme: "base",
      autoTheme: false,
      mermaidConfig: {
        securityLevel: "strict",
        flowchart: {
          curve: "linear",
          htmlLabels: false,
          nodeSpacing: 48,
          padding: 32,
          rankSpacing: 58,
          wrappingWidth: 220,
        },
        themeVariables: {
          background: "#000000",
          clusterBkg: "#050505",
          clusterBorder: "#4c1d95",
          edgeLabelBackground: "#000000",
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: "16px",
          lineColor: "#a78bfa",
          mainBkg: "#101010",
          nodeBorder: "#a855f7",
          primaryBorderColor: "#a855f7",
          primaryColor: "#101010",
          primaryTextColor: "#ffffff",
          secondaryBorderColor: "#7c3aed",
          secondaryColor: "#111827",
          secondaryTextColor: "#ffffff",
          tertiaryBorderColor: "#4a4a4a",
          tertiaryColor: "#050505",
          tertiaryTextColor: "#d0d0d0",
        },
      },
    }),
    starlight({
      title: "Render Harness Docs",
      description: "Interactive architecture docs for the Render agent harness.",
      customCss: ["./src/styles/theme.css"],
      editLink: {
        baseUrl: "https://github.com/render-lab/render-agent-harness/edit/main/docs-site/",
      },
      expressiveCode: {
        themes: ["github-dark-default"],
      },
      social: [
        {
          icon: "github",
          label: "GitHub repository",
          href: "https://github.com/render-lab/render-agent-harness",
        },
      ],
      components: {
        Footer: "./src/components/Footer.astro",
        Sidebar: "./src/components/Sidebar.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "" },
            { label: "Ways to use", slug: "ways-to-use" },
            { label: "Architecture", slug: "architecture" },
            { label: "Local development", slug: "local-development" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Core loop", slug: "core-loop" },
            { label: "Runtime paths", slug: "runtime-paths" },
            { label: "Platform constraints", slug: "platform-constraints" },
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
            { label: "Registry publishing", slug: "registry-publishing" },
            { label: "Harness versioning", slug: "harness-versioning" },
            { label: "Deployment model", slug: "deployment" },
            { label: "Web API", slug: "web-api" },
            { label: "Operator UI", slug: "operator-ui" },
            { label: "Capabilities", slug: "capabilities" },
            { label: "Authoring capability packs", slug: "authoring-capability-packs" },
            { label: "Authoring bundle templates", slug: "authoring-bundle-templates" },
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
