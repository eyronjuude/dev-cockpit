# 0013 — Draft a project's setup from its own files, with the model optional

**Status:** accepted

## Context

Registering a project means filling ten-odd command fields from memory. Nothing
helped: `probeRepository` did git checks only — resolve the root, guess the
default branch — and never opened a file in the target repository. The form's
only assistance was placeholder text hardcoded to npm, which is wrong for
Python, wrong for Cargo, and wrong for the pnpm projects already registered.

The cost was measurable. Every project in the database had an empty
`linkPaths` and an empty `setupCommand`, which is why landing validation was
failing on a missing `node_modules`: a form nobody can fill correctly gets
left blank.

## Decision

Two layers, and a new boundary rather than an extension of an existing one.

`collectRepoEvidence` reads manifests — `package.json`, `pyproject.toml`,
lockfiles, `Makefile`, tool configs — and returns facts. `proposeProjectSetup`
turns those facts into commands by plain rules. Neither calls a model.

`src/advisors` is an optional refinement pass over that proposal, with the same
interface-plus-registry shape as transformers and reviewers.
`DeterministicAdvisor` is the default and returns the rule-derived proposal
untouched.

The form gains a **Suggest setup** button. It fills form state and nothing
else: nothing is saved, and **Apply all** skips any field the user has already
filled, which is what `runProbe` already does with the name and default branch.

## Why

- **A model cannot read the repository here.** The read-only query behind the
  CLI providers runs with `--tools ""`, which is the guarantee that makes it
  safe to point at someone's code. So the evidence has to be gathered by our
  own code regardless, and once it has been, most of the answer is arithmetic:
  a `build` script beside a `pnpm-lock.yaml` implies `pnpm build` with no
  judgement required. The model earns its place on the ambiguous cases — which
  of three test scripts is the integration suite, what a bare `Makefile`
  project wants.
- **Not a transformer.** That layer's contract states it never sees or produces
  "source code, git diffs, test results, stack traces, file paths, screenshots
  or exit codes. It handles prose." An advisor deals in file paths and shell
  commands, which is precisely what that rule excludes. Bending it would have
  cost the guarantee for every other caller.
- **Optional, for the same reason the transformer layer is** (ADR 0005). The
  feature works on a machine with no CLI and no API key, and every credentialled
  provider falls back to the deterministic proposal with a reason rather than
  failing. A plain draft beats a broken button.
- **Never auto-applied.** A proposed command is a command that will later run
  under `bypassPermissions` (ADR 0010). The review step is the control, so it
  is structural: the API writes nothing, the button fills state, and every
  value is displayed in full before it can be applied.

## Consequences

- Registering a project is a review rather than a recall exercise, and the
  blank-`linkPaths` failure mode that motivated this has a self-service fix.
- Script names and values from the repository reach a model prompt. This is a
  prompt-injection channel that `--safe-mode` was closing, reopened
  deliberately and narrowed: extracted fields only, capped at 40 scripts and
  200 characters each, no `README` and no documentation. The residual risk is
  carried by the human review step, not by the prompt.
- Every advisor response is validated against a closed enum of the six
  validation kinds and length-capped per field, so a model cannot widen the
  kinds or land a page of text in a command box.
- Detection is a table of manifests and lockfiles, so a new ecosystem is a
  table entry. It will be wrong for unusual layouts; `confidence: 'low'` and
  the review step are how that stays cheap rather than dangerous.
- `pyproject.toml` is read with a two-header line scanner rather than a TOML
  parser. Adding a TOML dependency to read two table names would be the wrong
  trade, and the scanner produces no scripts rather than wrong ones when it
  cannot understand a file.
- Detection cannot verify a command, only propose one. Running a proposed
  command to test it would mean executing model-suggested shell against the
  developer's checkout, so the first run is the test — and a run whose
  worktree has no dependencies now says so rather than blaming the code
  (ADR 0004).
