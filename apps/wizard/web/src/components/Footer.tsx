import type { JSX, ReactNode } from "react";
import { LuArrowUpRight, LuExternalLink, LuGithub } from "react-icons/lu";

/**
 * Public-facing footer shown on every wizard page (browse, new, my,
 * success). Lives on the same brutalist tokens as the rest of the SPA;
 * the only color used is `text-accent` on hover, keeping the resting
 * state strictly grey.
 *
 * Three columns: Render (the platform), the Harness (this project),
 * Get started. The right-most column is the call-to-action surface for
 * visitors who landed here without a Render account.
 */
const REPO_URL = "https://github.com/render-lab/render-agent-harness";
const HARNESS_DOCS_URL = "https://render-agent-harness.onrender.com/";

interface LinkSpec {
  label: string;
  href: string;
  external?: boolean;
}

const COLUMNS: { id: string; heading: string; links: LinkSpec[] }[] = [
  {
    id: "render",
    heading: "// render",
    links: [
      { label: "Render.com", href: "https://render.com", external: true },
      { label: "Docs", href: "https://render.com/docs", external: true },
      { label: "Dashboard", href: "https://dashboard.render.com", external: true },
      { label: "Status", href: "https://status.render.com", external: true },
    ],
  },
  {
    id: "harness",
    heading: "// harness",
    links: [
      { label: "Browse", href: "/browse" },
      { label: "Create new", href: "/new" },
      { label: "Docs", href: HARNESS_DOCS_URL, external: true },
      { label: "GitHub", href: REPO_URL, external: true },
    ],
  },
  {
    id: "get-started",
    heading: "// get started",
    links: [
      {
        label: "Sign up for Render",
        href: "https://dashboard.render.com/register",
        external: true,
      },
      { label: "Sign in", href: "https://dashboard.render.com/login", external: true },
      { label: "Pricing", href: "https://render.com/pricing", external: true },
      { label: "Contact sales", href: "https://render.com/contact-sales", external: true },
    ],
  },
];

export function Footer(): JSX.Element {
  return (
    <footer className="border-t border-line bg-surface text-muted">
      <div className="mx-auto max-w-6xl px-5 py-10">
        <div className="grid gap-8 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <div key={col.id}>
              <div className="hr-section">
                <span>{col.heading}</span>
              </div>
              <ul className="mt-4 space-y-2 text-xs">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <FooterLink {...link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-[11px] text-muted">
          <span className="inline-flex items-center gap-2">
            Render Agent Harness · open source · MIT
          </span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-accent"
          >
            <LuGithub aria-hidden />
            render-lab/render-agent-harness
          </a>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ label, href, external }: LinkSpec): ReactNode {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-1.5 hover:text-accent"
      >
        {label}
        <LuExternalLink
          aria-hidden
          className="opacity-50 transition-opacity duration-100 group-hover:opacity-100"
        />
      </a>
    );
  }
  return (
    <a href={href} className="group inline-flex items-center gap-1.5 hover:text-accent">
      {label}
      <LuArrowUpRight
        aria-hidden
        className="opacity-0 transition-opacity duration-100 group-hover:opacity-60"
      />
    </a>
  );
}
