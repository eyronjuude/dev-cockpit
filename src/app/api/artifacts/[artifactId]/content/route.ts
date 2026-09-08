import { handle } from '@/app/api/_lib/handler';
import { notFound } from '@/core/errors';
import { getArtifact, readArtifactText } from '@/services/artifacts';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ artifactId: string }> };

/** Text content of an artifact, for inline display. Capped and tail-biased. */
export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { artifactId } = await params;
    const artifact = getArtifact(artifactId);
    if (!artifact) throw notFound('Artifact');

    const content = await readArtifactText(artifactId);
    if (!content) {
      return {
        artifact,
        content: null,
        message: 'The file recorded for this artifact is no longer on disk.',
      };
    }

    return { artifact, content, message: null };
  });
}
