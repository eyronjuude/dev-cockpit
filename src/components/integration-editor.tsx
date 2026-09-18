'use client';

import {
  INTEGRATION_TRANSPORT_LABELS,
  INTEGRATION_TRANSPORTS,
  type IntegrationTransport,
} from '@/domain/mcp-integrations';
import { uniqueStepKey } from '@/domain/validation-steps';

/**
 * The editor for one of a project's MCP integrations.
 *
 * Split out of the project form for the same reason `StepEditor` is: a
 * connection carries several fields whose relevance depends on the
 * transport, and most of that detail is one click away rather than always on
 * screen. Key generation reuses `slugifyStepKey`/`uniqueStepKey` — the slug
 * rules a validation step's key follows apply here unchanged.
 */

export interface IntegrationState {
  key: string;
  label: string;
  transport: IntegrationTransport;
  command: string;
  /** Newline-separated. `stdio` only. */
  args: string;
  /** Newline-separated `KEY=VALUE`. `stdio` only. */
  env: string;
  url: string;
  /** Newline-separated `KEY=VALUE`. `http` only. */
  headers: string;
  enabled: boolean;
  /** Open in the editor. Presentation only; never persisted. */
  expanded: boolean;
}

export function blankIntegration(key: string, label: string): IntegrationState {
  return {
    key,
    label,
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    enabled: true,
    expanded: true,
  };
}

/** A new integration appended to the list, with a key nothing else has taken. */
export function newIntegrationFor(existing: readonly IntegrationState[]): IntegrationState {
  const taken = new Set(existing.map((integration) => integration.key));
  return blankIntegration(uniqueStepKey('New integration', taken), 'New integration');
}

export function IntegrationEditor({
  integration,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  integration: IntegrationState;
  index: number;
  total: number;
  onChange: (patch: Partial<IntegrationState>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const summary = integration.transport === 'stdio' ? integration.command : integration.url;

  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 text-[11px] tabular-nums text-ink-faint">{index + 1}</span>

        <input
          className="input max-w-40"
          value={integration.label}
          placeholder="Integration name"
          onChange={(e) => onChange({ label: e.target.value })}
          aria-label={`Integration ${index + 1} name`}
        />

        <input
          className="input input-mono flex-1"
          value={summary}
          placeholder={
            integration.transport === 'stdio' ? 'npx -y @some/mcp-server' : 'https://…'
          }
          onChange={(e) =>
            onChange(
              integration.transport === 'stdio'
                ? { command: e.target.value }
                : { url: e.target.value },
            )
          }
          aria-label={`Integration ${index + 1} ${integration.transport === 'stdio' ? 'command' : 'url'}`}
        />

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          title="Move earlier"
          aria-label={`Move ${integration.label} earlier`}
        >
          &uarr;
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          title="Move later"
          aria-label={`Move ${integration.label} later`}
        >
          &darr;
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onChange({ expanded: !integration.expanded })}
          aria-expanded={integration.expanded}
        >
          {integration.expanded ? 'Less' : 'More'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost text-fail"
          onClick={onRemove}
          aria-label={`Remove ${integration.label}`}
        >
          Remove
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 pl-8">
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
          Transport
          <select
            className="input max-w-40"
            value={integration.transport}
            onChange={(e) => onChange({ transport: e.target.value as IntegrationTransport })}
            aria-label={`${integration.label} transport`}
          >
            {INTEGRATION_TRANSPORTS.map((transport) => (
              <option key={transport} value={transport}>
                {INTEGRATION_TRANSPORT_LABELS[transport]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted">
          <input
            type="checkbox"
            className="accent-accent"
            checked={integration.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          enabled
        </label>
      </div>

      {integration.expanded ? (
        <div className="ml-2 mt-3 space-y-3 border-l-2 border-line pl-6">
          {integration.transport === 'stdio' ? (
            <div>
              <label className="label">Arguments</label>
              <textarea
                className="input input-mono min-h-14"
                value={integration.args}
                placeholder={'-y\n@some/mcp-server'}
                onChange={(e) => onChange({ args: e.target.value })}
              />
              <p className="hint">One argument per line, in order.</p>
            </div>
          ) : null}

          <div>
            <label className="label">
              {integration.transport === 'stdio' ? 'Environment' : 'Headers'}
            </label>
            <textarea
              className="input input-mono min-h-14"
              value={integration.transport === 'stdio' ? integration.env : integration.headers}
              placeholder="ONE_PER_LINE=value"
              onChange={(e) =>
                onChange(
                  integration.transport === 'stdio'
                    ? { env: e.target.value }
                    : { headers: e.target.value },
                )
              }
            />
            <p className="hint">
              One <span className="mono">KEY=VALUE</span> per line. Secret-looking values are
              masked in captured output.
            </p>
          </div>

          <p className="hint">
            Key <span className="mono">{integration.key}</span> &mdash; this is the server name a
            run&apos;s generated MCP configuration uses.
          </p>
        </div>
      ) : null}
    </div>
  );
}
