import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Db } from '../db/index.js'
import { getOrgMetrics } from '../analytics/index.js'
import { listSessions } from '../sessions/index.js'
import { createOrg, listOrgs } from '../orgs/index.js'
import { createLocalhostOAuthProvider } from '../collection/server.js'

export async function buildApiServer(db: Db, collectionPort: number) {
  const app = Fastify({ logger: false })
  const oauthProvider = createLocalhostOAuthProvider(db)

  await app.register(cors)

  app.get('/health', async () => {
    return { ok: true }
  })

  app.get<{ Params: { orgId: string } }>('/orgs/:orgId/metrics', async (request) => {
    const { orgId } = request.params
    return getOrgMetrics(db, orgId)
  })

  app.get<{ Params: { orgId: string } }>('/orgs/:orgId/sessions', async (request) => {
    const { orgId } = request.params
    return listSessions(db, orgId)
  })

  // ── Admin routes ──────────────────────────────────────────────────────────

  app.get('/admin/orgs', async () => {
    return listOrgs(db)
  })

  app.post<{ Body: { slug: string; name: string } }>('/admin/orgs', async (request, reply) => {
    const { slug, name } = request.body ?? {}
    if (!slug || !name) {
      return reply.status(400).send({ error: 'slug and name are required' })
    }
    return createOrg(db, { slug, name })
  })

  app.post<{ Body: { orgSlug: string; email: string; name?: string } }>('/admin/register', async (request, reply) => {
    const { orgSlug, email, name } = request.body ?? {}
    if (!orgSlug) return reply.status(400).send({ error: 'orgSlug is required' })
    if (!email || !email.includes('@')) return reply.status(400).send({ error: 'A valid email is required' })
    try {
      const token = await oauthProvider.issueToken(orgSlug, email, name)
      const orgCtx = await oauthProvider.verifyToken(token)
      return { token, developerId: orgCtx?.developerId }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return reply.status(400).send({ error: message })
    }
  })

  app.get('/admin', async (_request, reply) => {
    const orgsData = await listOrgs(db)
    const orgsRows = orgsData.map(o =>
      `<tr><td>${escHtml(o.id)}</td><td>${escHtml(o.slug)}</td><td>${escHtml(o.name)}</td></tr>`
    ).join('\n')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Observability Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; padding: 2rem; }
    h1 { font-size: 1.6rem; margin-bottom: 2rem; color: #111; }
    h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #333; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-bottom: 2rem; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.5rem; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.3rem; color: #555; }
    input { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; margin-bottom: 0.8rem; }
    button { background: #2563eb; color: #fff; border: none; border-radius: 4px; padding: 0.55rem 1.2rem; font-size: 0.9rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
    th { background: #f0f0f0; text-align: left; padding: 0.6rem 1rem; font-size: 0.82rem; color: #555; }
    td { padding: 0.6rem 1rem; font-size: 0.88rem; border-top: 1px solid #f0f0f0; }
    #result { margin-top: 1.2rem; }
    .result-box { background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 1rem; }
    .result-box p { font-size: 0.88rem; margin-bottom: 0.5rem; }
    .result-box pre { background: #1e1e1e; color: #d4d4d4; padding: 0.75rem; border-radius: 4px; font-size: 0.8rem; overflow-x: auto; white-space: pre; }
    .error-box { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px; padding: 1rem; font-size: 0.88rem; color: #b91c1c; }
    .copy-btn { background: #6b7280; font-size: 0.78rem; padding: 0.3rem 0.7rem; margin-left: 0.5rem; }
    .copy-btn:hover { background: #4b5563; }
  </style>
</head>
<body>
  <h1>Agent Observability — Admin</h1>

  <div class="grid">
    <div class="card">
      <h2>Create Organisation</h2>
      <form id="orgForm">
        <label for="orgSlug">Slug</label>
        <input id="orgSlug" name="slug" placeholder="acme-corp" required>
        <label for="orgName">Name</label>
        <input id="orgName" name="name" placeholder="Acme Corp" required>
        <button type="submit">Create Org</button>
      </form>
    </div>

    <div class="card">
      <h2>Register Developer</h2>
      <form id="devForm">
        <label for="devOrgSlug">Org Slug</label>
        <input id="devOrgSlug" name="orgSlug" placeholder="acme-corp" required>
        <label for="devEmail">Email</label>
        <input id="devEmail" name="email" type="email" placeholder="dev@example.com" required>
        <label for="devName">Name (optional)</label>
        <input id="devName" name="name" placeholder="Alice">
        <button type="submit">Register &amp; Get Token</button>
      </form>
      <div id="result"></div>
    </div>
  </div>

  <h2>Organisations</h2>
  <table id="orgsTable">
    <thead><tr><th>ID</th><th>Slug</th><th>Name</th></tr></thead>
    <tbody>${orgsRows}</tbody>
  </table>

  <script>
    const COLLECTION_PORT = ${collectionPort};

    document.getElementById('orgForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const res = await fetch('/admin/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: fd.get('slug'), name: fd.get('name') }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert('Error: ' + (err.error || res.statusText));
      }
    });

    document.getElementById('devForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { orgSlug: fd.get('orgSlug'), email: fd.get('email') };
      const name = fd.get('name');
      if (name) body.name = name;
      const res = await fetch('/admin/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const resultEl = document.getElementById('result');
      if (!res.ok) {
        resultEl.innerHTML = '<div class="error-box">Error: ' + (data.error || res.statusText) + '</div>';
        return;
      }
      const mcpConfig = JSON.stringify({
        mcpServers: {
          "agent-observability": {
            type: "http",
            url: "http://127.0.0.1:" + COLLECTION_PORT + "/mcp",
            headers: { Authorization: "Bearer " + data.token }
          }
        }
      }, null, 2);
      resultEl.innerHTML = \`<div class="result-box">
        <p><strong>Token:</strong> \${data.token} <button class="copy-btn" onclick="navigator.clipboard.writeText('\${data.token}')">Copy</button></p>
        <p><strong>Developer ID:</strong> \${data.developerId ?? 'n/a'}</p>
        <p style="margin-top:0.75rem"><strong>MCP Config:</strong> <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('mcpJson').textContent)">Copy</button></p>
        <pre id="mcpJson">\${mcpConfig.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      </div>\`;
    });
  </script>
</body>
</html>`

    return reply.type('text/html').send(html)
  })

  return app
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
