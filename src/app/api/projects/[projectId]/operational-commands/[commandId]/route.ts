import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import {
  deleteOperationalCommand,
  operationalCommandInputSchema,
  requireOperationalCommand,
  updateOperationalCommand,
} from '@/services/operational-commands';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string; commandId: string }> };

export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { commandId } = await params;
    return { operationalCommand: requireOperationalCommand(commandId) };
  });
}

export function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { commandId } = await params;
    const body = operationalCommandInputSchema.partial().parse(await readJson(request));
    const command = updateOperationalCommand(commandId, body);
    return { operationalCommand: command };
  });
}

export function DELETE(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { commandId } = await params;
    deleteOperationalCommand(commandId);
    return { ok: true };
  });
}
