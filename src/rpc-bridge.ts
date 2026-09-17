// Project-owned companion. Supported Gateway SDK, authenticated as this host's
// operator just like the existing bounded native helpers. Never logs credentials.
import { createInterface } from 'node:readline';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import {
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';
import { companionMethodAllowed } from './bridge-methods.js';
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  let id;
  try {
    const q = JSON.parse(line);
    id = q.id;
    let result;
    if (q.method === 'jarvis-gilfoyle.session.cleanup') {
      const p = q.params,
        m = /^agent:([^:]+):([a-z][a-z0-9_-]{0,31}):([0-9a-f-]{36})$/.exec(p.sessionKey ?? '');
      if (
        !m ||
        m[1] !== p.agentId ||
        m[2] !== p.sessionNamespace ||
        !/^[0-9a-f-]{36}$/.test(p.projectId ?? '')
      )
        throw Error('Invalid owned cleanup scope');
      const entry = getSessionEntry({ agentId: p.agentId, sessionKey: p.sessionKey });
      if (entry && entry.sessionId !== p.expectedSessionId)
        throw Error('Session generation changed before cleanup');
      const marker = JSON.stringify(
        `PROJECT CONTINUATION\nProject: ${p.projectId}\nScope: ${m[3]}`,
      ).slice(1, -1);
      result = await cleanupSessionLifecycleArtifacts({
        agentId: p.agentId,
        sessionKeySegmentPrefix: `${p.sessionNamespace}:${m[3]}`,
        transcriptContentMarker: marker,
        archiveRemovedEntryTranscripts: false,
        orphanTranscriptMinAgeMs: 0,
        nowMs: Date.now(),
      });
    } else {
      if (!companionMethodAllowed(q.method)) throw Error('Unsupported companion method');
      result = await callGatewayFromCli(q.method, { timeout: '20000', json: true }, q.params, {
        scopes: ['operator.read', 'operator.write', 'operator.admin'],
      });
    }
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id, error: String(error.message).slice(0, 1000) }) + '\n',
    );
  }
});
