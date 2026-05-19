import { useState } from "react";
import type { ScaffoldResponse, WizardState } from "../lib/types.js";

export function Success({ state, result }: { state: WizardState; result: ScaffoldResponse }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-6">
        <div className="hr-section">
          <span>{`// ${state.agentName.toUpperCase()} READY`}</span>
        </div>
      </header>

      <div className="panel p-6">
        <p className="text-sm">
          Private repository created in the Render-managed GitHub org. Scaffolded files committed.
          Click below to deploy.
        </p>

        <a
          href={result.deployUrl}
          target="_blank"
          rel="noreferrer"
          className="btn btn-primary mt-5 w-full"
          style={{ padding: "0.7rem 1rem", fontSize: "0.85rem" }}
        >
          Deploy to Render →
        </a>

        <dl className="mt-6 space-y-2 text-[12px]">
          <div className="grid grid-cols-[5rem_1fr] gap-3">
            <dt className="label">repo</dt>
            <dd>
              <a
                href={result.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                {result.repoUrl}
              </a>
            </dd>
          </div>
          <div className="grid grid-cols-[5rem_1fr] gap-3">
            <dt className="label">slug</dt>
            <dd>{result.repoSlug}</dd>
          </div>
        </dl>
      </div>

      {result.claimUrl ? (
        <div className="panel mt-5 border-accent p-6 text-sm">
          <div className="label text-accent">{"// CLAIM LATER"}</div>
          <p className="mt-2">
            This scaffold was anonymous. Save this one-time link. Signing in with GitHub and
            visiting it will add you as a collaborator and link the repo to your account.
          </p>
          <a
            href={result.claimUrl}
            className="mt-3 block break-all border border-line bg-canvas p-2 text-[11px] text-accent hover:underline"
          >
            {result.claimUrl}
          </a>
        </div>
      ) : null}

      {result.deployKey ? <DeployKeyPanel deployKey={result.deployKey} /> : null}

      <div className="panel mt-5 p-6">
        <div className="label">{"// WHAT HAPPENS NEXT"}</div>
        <ol className="mt-3 space-y-1.5 text-sm">
          <Step n={1}>
            Click <span className="text-accent">Deploy to Render</span>.
          </Step>
          <Step n={2}>Sign in to Render (free for hobby use).</Step>
          <Step n={3}>
            Fill in{" "}
            <code className="bg-[var(--color-code-bg)] px-1 text-[12px]">ANTHROPIC_API_KEY</code>{" "}
            and any other env vars the Blueprint asks for.
          </Step>
          {result.deployKey ? (
            <Step n={4}>
              When Render prompts for{" "}
              <code className="bg-[var(--color-code-bg)] px-1 text-[12px]">GITHUB_DEPLOY_KEY</code>{" "}
              and{" "}
              <code className="bg-[var(--color-code-bg)] px-1 text-[12px]">
                GITHUB_DEPLOY_REPO_SSH_URL
              </code>
              , paste the values from the panel above. These enable edit-in-UI from the operator UI.
            </Step>
          ) : null}
          <Step n={result.deployKey ? 5 : 4}>
            Click <span className="text-accent">Apply</span>. Render provisions services (web,
            worker, cron, plus Postgres + Key Value). Takes ~2 minutes.
          </Step>
          <Step n={result.deployKey ? 6 : 5}>Agent is live at the URL Render shows you.</Step>
        </ol>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="label shrink-0 text-accent">{String(n).padStart(2, "0")}.</span>
      <span>{children}</span>
    </li>
  );
}

/**
 * Save-this-credential block. The PEM is shown once, here, and never
 * persisted server-side beyond the SSE `done` event — if the operator
 * loses it before pasting into Render they need to rotate the key
 * manually (GitHub Settings → Deploy keys). Future Config tab will
 * surface a one-click rotate.
 */
function DeployKeyPanel({ deployKey }: { deployKey: NonNullable<ScaffoldResponse["deployKey"]> }) {
  return (
    <div className="panel mt-5 border-accent p-6 text-sm">
      <div className="label text-accent">{"// SAVE THIS COMMIT CREDENTIAL"}</div>
      <p className="mt-2">
        The wizard generated an SSH deploy key scoped to this repo. Paste it into Render when the
        Blueprint prompts for environment variables. Edit-in-UI (Install capability, Add agent, Edit
        model) won't work until both values are set on the deployed service.
      </p>
      <p className="mt-2 text-[12px] text-muted">
        Lose it and you'll need to regenerate manually (GitHub Settings → Deploy keys for this
        repo, plus the same env var on the Render service). Fingerprint: {deployKey.fingerprint}.
      </p>
      <CopyField
        label="GITHUB_DEPLOY_REPO_SSH_URL"
        value={deployKey.repoSshUrl}
        multiline={false}
      />
      <CopyField label="GITHUB_DEPLOY_KEY" value={deployKey.privatePem} multiline={true} />
    </div>
  );
}

function CopyField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <button type="button" onClick={onCopy} className="text-[11px] text-accent hover:underline">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {multiline ? (
        <pre className="mt-1 max-h-48 overflow-auto border border-line bg-canvas p-2 text-[11px] leading-tight whitespace-pre">
          {value}
        </pre>
      ) : (
        <div className="mt-1 break-all border border-line bg-canvas p-2 text-[11px]">{value}</div>
      )}
    </div>
  );
}
