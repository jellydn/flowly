import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { RepoAssistant } from './agents/repo-assistant.ts';
import { PrReviewer } from './agents/pr-reviewer.ts';

const app = new Hono();

app.route('/agents/repo-assistant', createAgentRouter(RepoAssistant));
app.route('/agents/pr-reviewer', createAgentRouter(PrReviewer));
app.get('/api/ping', (c) => c.text('pong'));

export default app;
