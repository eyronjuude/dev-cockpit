import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import {
  createOperationalCommand,
  listOperationalCommands,
  operationalCommandInputSchema,
} from '@/services/operational-commands';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { projectId } = await params;
    return { operationalCommands: listOperationalCommands(projectId) };
  });
}

export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { projectId } = await params;
    const body = operationalCommandInputSchema.parse(await readJson(request));
    const command = createOperationalCommand(projectId, body);
    return { operationalCommand: command };
  });
}
