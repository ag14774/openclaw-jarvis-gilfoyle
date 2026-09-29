// Project-owned companion. Supported Gateway SDK, authenticated as this host's
// operator just like the existing bounded native helpers. Never logs credentials.
import { createInterface } from 'node:readline';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import {
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
} from 'openclaw/plugin-sdk/session-store-runtime';
import { cleanupScope, companionMethodAllowed, companionScopes } from './bridge-methods.js';
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  let id;
  try {
    const q = JSON.parse(line);
    id = q.id;
    let result;
    if (q.method === 'jarvis-gilfoyle.session.cleanup') {
      const p = q.params,
        owned = cleanupScope(p);
      if (!owned) throw Error('Invalid owned cleanup scope');
      const entry = getSessionEntry({ agentId: p.agentId, sessionKey: p.sessionKey });
      if (entry && entry.sessionId !== p.expectedSessionId)
        throw Error('Session generation changed before cleanup');
      const marker = JSON.stringify(`PROJECT TASK ${owned.scope}`).slice(1, -1);
      result = await cleanupSessionLifecycleArtifacts({
        agentId: p.agentId,
        sessionKeySegmentPrefix: `${p.sessionNamespace}:${owned.scope}`,
        transcriptContentMarker: marker,
        archiveRemovedEntryTranscripts: false,
        orphanTranscriptMinAgeMs: 0,
        nowMs: Date.now(),
      });
    } else {
      if (!companionMethodAllowed(q.method, q.params)) throw Error('Unsupported companion method');
      result = await callGatewayFromCli(q.method, { timeout: '20000', json: true }, q.params, {
        scopes: companionScopes(q.method, q.params),
      });
    }
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id, error: String(error.message).slice(0, 1000) }) + '\n',
    );
  }
});
