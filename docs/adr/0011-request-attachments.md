# 0011 — Request attachments

**Status:** accepted

## Context

A request is a text box. Plenty of requests are not text: the screenshot of the
broken page, the 40,000-line log from the crash, the design the change is meant
to match, the CSV whose shape the importer has to handle. Today the only way to
hand one of those over is to describe it, or commit it to the repository so the
agent can find it — which puts a debugging artefact in the history to get one
run done.

Four questions had to be answered before any of this was buildable.

1. When can a file be attached — at creation, afterwards, or both?
2. How does an attachment reach the agent?
3. Where do the bytes live?
4. What may be attached?

## Decision

### Both, but only while the list can still be read

Attachments can be added when a request is created and afterwards, while the
run is in a status that can re-enter implementation: `DRAFT`, `NEEDS_CHANGES`,
`READY`, `PAUSED`, `FAILED`, `CANCELLED`. The set is `ATTACHMENT_MUTABLE_STATUSES` in
`domain/attachments.ts`.

Create-only would have been simpler and would have missed the best case for the
feature. The run comes back wrong, you screenshot what is still wrong, attach
it, and press **Request changes**; the next iteration reads it. That is worth
the extra endpoint.

The other direction — always mutable — was rejected because it would be a lie.
While a run is implementing, the prompt handed to the agent has already been
built. A file accepted then would appear attached and reach nothing. The status
gate makes that visible instead: the list goes read-only, with a line saying
the run has moved past reading its inputs.

Both add and remove are recorded as run events, so a file that was attached and
later withdrawn still shows in the log. The list says what is attached now; the
event log says what the agent was given.

### Paths, from outside the worktree

The agent is handed the directory with Claude Code's `--add-dir` and every file
by absolute path in its prompt. It opens what it needs with its own tools.

Two alternatives were rejected.

**Copy them into the worktree.** The obvious thing, and wrong: everything in
the worktree lands in the diff. An attached log is not a change the developer
asked for, and a run whose Changes tab lists `crash.log` has muddled evidence
with input.

**Paste the contents into the prompt.** Impossible for a screenshot and wasteful
for a log — it spends the context window on bytes the agent may never want.
A path lets it read the last 200 lines and stop.

`readableAttachments` in `orchestrator/prompt.ts` is the single source of which
files count, deliberately, because two callers must agree: the one that names
paths in the prompt and the one that grants the directory. A prompt naming a
path the session cannot open costs the agent a turn to discover. A grant the
prompt never mentions is access for nothing.

A follow-up prompt marks the files that arrived since the last iteration
started. On a resumed session the older ones are repeated anyway — four lines
is cheap, and the alternative is that a screenshot attached specifically to
explain this round of feedback goes unmentioned.

### Their own root, not `artifacts/`

`data/attachments/<runId>/<attachmentId>__<name>`, with a row in a new
`attachments` table.

The shape is nearly identical to `artifacts`, and reusing that table was
tempting. The direction of travel is what makes them different. An artifact is
evidence a run produced, and `artifact_retention_days` exists so retention can
delete it. An attachment is an input the developer supplied and is the only copy
the app holds. Sharing one table and one directory would mean every cleanup
path had to remember which rows it must not touch. Two roots means it cannot
get that wrong.

One directory per run rather than one shared root, because the whole directory
is handed to the agent. A shared root would grant read access to every other
run's attachments at the same time.

Bytes are stored **verbatim**. Text artifacts go through secret redaction on
the way in because they are machine output that may have picked up a
credential. An attachment is a file the developer chose to hand over; rewriting
it would corrupt a screenshot and falsify a log.

### Anything, and the type decides only how it is served

10 files per request, 25 MB each, no restriction on type.

An allow-list of permitted types was considered and rejected as theatre. The
user picked these files off their own machine, nothing here executes them, and
refusing a `.zip` teaches nothing. What the type does decide is real: how the
download route serves the bytes.

- `.html`, `.htm`, `.xhtml` map to `text/plain` **deliberately**. Served as a
  document, an attached page would run script in this application's own origin,
  and this application drives Claude Code and shell commands on the machine.
- SVG keeps `image/svg+xml`, because an inline preview is worth having, and the
  route serves it under `Content-Security-Policy: sandbox`.
- Anything unlisted is `application/octet-stream`, which is always a download.

The type is derived from the extension, never taken from the browser's
`File.type`, which the page controls. `X-Content-Type-Options: nosniff` on
every response stops the browser overriding the decision.

The count limit exists because every attachment is listed to the agent; a
hundred of them would crowd out the request itself.

## Consequences

- The transformer still never sees a file. That boundary handles prose by
  design, so a specification is built from the request text alone and the
  attachments inform the implementation only. Stated in the New task screen
  rather than left to be discovered.
- Nothing prunes attachments, by the same logic that keeps them out of
  retention. `purgeRunAttachments` exists for a future path that discards a run
  outright.
- The per-run limit is checked read-then-write, so two simultaneous uploads
  could leave eleven files. Single-user local app; not worth a transaction.
- `POST /api/runs` accepts multipart as well as JSON. Fields ride in a JSON
  `payload` part and are parsed by the same Zod schema either way, so a request
  with nothing to attach stays a plain JSON body.
- Delivery has not been exercised against a live CLI. The wiring is deliberate
  but no end-to-end run has confirmed Claude Code reads an attached screenshot
  from an added directory. Listed in the README's current limitations.
