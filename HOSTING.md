# StreamDoctor hosting notes

StreamDoctor is already container-ready. The HTTP service listens on `PORT` and must be exposed through HTTPS by your hosting provider or reverse proxy.

## Required production settings

- `PORT`: supplied by the host, or `7000` in Docker.
- `PUBLIC_URL`: optional but recommended, for example `https://doctor.example.com`. Do not add a trailing slash.
- `DATA_DIR`: persistent directory used for `configs.json`. In the Docker image use `/app/data`.
- `ALLOW_PRIVATE_NETWORKS=false`: keep disabled on a public server.
- `PROBE_CONCURRENCY=4`: good starting value.

## Persistence matters

Every configured addon receives an ID such as:

`https://doctor.example.com/AbCdEf123/manifest.json`

The settings behind that ID are stored in `DATA_DIR/configs.json`. If the hosting filesystem is ephemeral and the container restarts, those IDs can disappear. Attach a persistent volume to `/app/data` or point `DATA_DIR` at your host's persistent storage.

## Docker / VPS

```bash
docker compose up -d --build
```

Then put an HTTPS reverse proxy in front of port 7000 and set `PUBLIC_URL` to the public HTTPS origin.

## Routes

- `/` — branded landing page
- `/configure` — addon configurator
- `/manifest.json` — base addon manifest
- `/health` — health check
- `/logo.png` — addon logo

## Before publishing

1. Use HTTPS.
2. Keep private network access disabled.
3. Attach persistent storage.
4. Set `PUBLIC_URL` if your host/proxy does not forward protocol/host headers correctly.
5. Test one configured manifest after a restart to confirm persistence.
