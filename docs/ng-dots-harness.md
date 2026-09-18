# NG Dots native harness

Cloudflare OS should be the user's agent harness for NG Dots. A user connects an NG Dots account,
describes or imports a VibeApp, reviews the proposed action, and lets the built-in agent carry the
work through the governed NG Dots path. Claude Desktop, Cursor, Codex, local Git, and a local Node
runtime are not prerequisites.

## Authority boundaries

- The NG Dots gateway remains the policy and audit authority. The Gatekeeper never calls the
  Cloudflare or GitHub administration APIs directly.
- Every gateway read is authorized as an observation before its result is returned.
- Every mutation is stored in the Gatekeeper and submitted to Cloudflare OS's approval queue. The
  gateway call is made only from `applyAction()` after approval.
- Source import is report-only first. Secret-like files, symlinks, path traversal, and unknown
  frameworks fail closed. Backend and framework-specific runtime features require review.
- Creation, source publication, pull-request creation, merge/deploy, and destructive lifecycle
  operations remain distinct actions.

## Delivery phases

Status as of 2026-09-18. All work is local and uncommitted; nothing is pushed or deployed.

### 1. Native connection and planning — implemented

`packages/gatekeeper-ng-dots` supplies the gateway client, account connection, import inventory
analysis, governed reads, and the approval-gated create/import actions.

### 2. Hosted callback support in the gateway — implemented (gateway worktree)

The gateway accepts a hosted return URL only as `<allowlisted base>/oauth/<64 hex Durable Object
ID>/<43 character base64url nonce>`, always with PKCE, on the existing single-use 60-second
handshake. Bases are exact HTTPS URLs with no credentials, query, fragment, wildcard, encoding, or
traversal.

Operators set the base to this Gatekeeper's `BASE_URL` in the gateway `configuration.yaml`:

```yaml
platform:
  hostedHarness:
    callbackBases:
      - https://<worker>/gatekeeper/ng-dots
```

which the deploy tooling exports as `HOSTED_HARNESS_CALLBACK_BASES_JSON`. An empty list disables
hosted sign-in.

### 3. Hosted source publication in the gateway — implemented (gateway worktree)

```text
GET  /plugin/api/apps/:businessUnit/:slug/default-branch
POST /plugin/api/apps/:businessUnit/:slug/source-branches
{
  "operation": "create" | "import",
  "branch": "ng-dots/<create|import>-<uuid>",
  "baseSha": "<current main sha>",
  "files": [{ "path": "...", "contentBase64": "...", "mode": "100644" | "100755" }],
  "importReport": { "framework": "...", "reviewedFindingCodes": ["..."] }
}
```

The gateway re-validates everything at the authority boundary: normalized relative paths, no
`.git/` or `.github/` paths, no secret-bearing files or symlinks, at most 2000 files, 2 MiB per
file, 8 MiB total, an exact branch shape, and a 40-hex `baseSha` that must equal the current `main`.
It derives repository and installation identity from the registry record only, overlays the files on
`main`'s tree as one commit on the new branch through the existing repository-scoped GitHub App, and
never writes `main`. The commit message carries a content digest, so repeating the same request
returns the existing commit and a different payload for an existing branch is rejected. The pull
request is then opened with the existing `/pulls` endpoint.

Not implemented: server-side rendering of the pinned boilerplate and NG Dots configuration. The
template contract lives in the private boilerplate repository and the desktop plugin, neither of
which was available to this work, so the gateway publishes exactly the manifest it is given rather
than guessing at a template. The built-in agent therefore supplies the complete source tree for both
create and import. Add trusted server-side rendering once the template contract is available.

### 4. End-to-end create and import actions — implemented

`createVibeApp` and `importVibeApp` take `{ businessUnit, slug, files, acknowledgedFindingCodes }`.
Before anything is queued the Gatekeeper decodes the files, derives sizes from content, runs the
shared analyzer, and fails on any blocking finding or unacknowledged review finding.

One approval shows the BU, slug, source summary, accepted review findings, the exact branch, and the
pull-request intent, and states that merge and deployment are not covered. Nothing reaches the
gateway before approval. After approval the operation runs as a resumable pipeline: provision the
repository, read `main`'s SHA (persisted so retries reuse it), publish the source branch, open the
pull request. A failure records the exact gateway error and keeps finished stages; applying again
resumes without repeating them.

`getVibeAppOperation(approvalId)` reports only observed stages: repository provisioned, source
branch and commit, pull request (number, URL, whether NG Dots enabled auto-merge). Merged, deployment
queued, deployed, and live verified are listed as `notObserved` and are never inferred. The gateway
may enable auto-merge on the pull request, so a merge can follow without another approval once the
repository's checks pass; observe it through the existing status endpoints.

## Completion criteria for the first public milestone

1. A user connects with Entra in the Cloudflare OS UI without installing a desktop harness.
2. The built-in agent can read identity, app inventory, models, and app state through observations.
3. Import analysis rejects secrets/symlinks/traversal and surfaces compatibility review items.
4. Create/import each show one complete approval containing BU, slug, source summary, findings, and
   intended branch/PR, then run only after approval.
5. The result always distinguishes planned, repository-created, branch-created, PR-opened, merged,
   deployed, and failed states.
6. Contract, unit, and end-to-end tests cover token refresh, callback allowlisting, manifest limits,
   action rejection, retry/idempotency, and exact gateway error propagation.
