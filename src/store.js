import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class ConfigStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'configs.json');
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.file);
    } catch {
      await fs.writeFile(this.file, '{}\n', 'utf8');
    }
  }

  async readAll() {
    await this.init();
    const raw = await fs.readFile(this.file, 'utf8');
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }

  async get(id) {
    const all = await this.readAll();
    return all[id] || null;
  }

  async create(config) {
    const id = crypto.randomBytes(9).toString('base64url');
    this.queue = this.queue.then(async () => {
      const all = await this.readAll();
      all[id] = { ...config, createdAt: new Date().toISOString() };
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.file);
    });
    await this.queue;
    return id;
  }
}
