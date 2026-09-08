import { isActive } from '@/domain/types';
import { subscribeToRun, type BusMessage } from '@/services/bus';
import { listEvents } from '@/services/events';
import { getRun } from '@/services/runs';
import { isRunActive } from '@/orchestrator/orchestrator';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/**
 * Server-sent events for one run.
 *
 * The `lastSeq` query parameter (or the standard `Last-Event-ID` header) is a
 * cursor into the persisted event log, so a reconnect or a page reload replays
 * exactly what was missed rather than starting blank. Persistence is the source
 * of truth; the in-process bus only decides when to wake up.
 */
export async function GET(request: Request, { params }: Params) {
  const { runId } = await params;
  const run = getRun(runId);

  if (!run) {
    return new Response('Run not found', { status: 404 });
  }

  const url = new URL(request.url);
  const headerCursor = request.headers.get('last-event-id');
  const queryCursor = url.searchParams.get('lastSeq');
  const startFrom = Number.parseInt(queryCursor ?? headerCursor ?? '0', 10);
  let cursor = Number.isFinite(startFrom) && startFrom > 0 ? startFrom : 0;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        try {
          const idLine = id === undefined ? '' : `id: ${id}\n`;
          controller.enqueue(
            encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // The client went away between the check and the write.
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // Catch-up: everything the client has not seen yet, in pages. A busy run
      // produces more events than one query returns, and stopping at the first
      // page would leave a hole in the middle of the log — live events would
      // still arrive, so the gap would be silent rather than obvious.
      const PAGE = 500;
      for (;;) {
        const page = listEvents(runId, { afterSeq: cursor, limit: PAGE });
        if (page.length === 0) break;
        for (const event of page) {
          cursor = Math.max(cursor, event.seq);
          send('run-event', event, event.seq);
        }
        if (closed || page.length < PAGE) break;
      }

      send('sync', {
        runId,
        status: run.status,
        cursor,
        active: isRunActive(runId) || isActive(run.status),
      });

      // Live events. Out-of-order or already-sent sequences are dropped so a
      // race between catch-up and the bus cannot duplicate a line.
      unsubscribe = subscribeToRun(runId, (message: BusMessage) => {
        if (message.event.seq <= cursor) return;
        cursor = message.event.seq;
        send('run-event', message.event, message.event.seq);
      });

      // Comment-only frames keep proxies and browsers from timing out an idle
      // stream during a long implementation.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          cleanup();
        }
      }, 20_000);

      request.signal.addEventListener('abort', cleanup);
    },

    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops any intermediate proxy from buffering the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
