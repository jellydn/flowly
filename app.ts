import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { RepoAssistant } from './agents/repo-assistant.ts';

const app = new Hono();

app.route('/agents/repo-assistant', createAgentRouter(RepoAssistant));
app.get('/api/ping', (c) => c.text('pong'));

export default app;
