import http from 'node:http';
import { createRequestListener } from './app.js';

const port = Number(process.env.PORT || 7000);
const handler = await createRequestListener();
const server = http.createServer(handler);
server.listen(port, '0.0.0.0', () => {
  console.log(`StreamDoctor listening on http://0.0.0.0:${port}`);
  console.log(`Configure: http://127.0.0.1:${port}/configure`);
});
