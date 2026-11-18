import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const deploy = (name: string): string => readFileSync(resolve(__dirname, '../../deploy', name), 'utf8');
const deployDir = resolve(__dirname, '../../deploy');

test('la unidad usa el usuario dedicado, credenciales de 006 y cierre compatible', () => {
  const unit = deploy('gtlock-middleware.service');
  const lines = unit.split(/\r?\n/);
  for (const line of [
    'Type=simple', 'User=gtlock', 'Group=gtlock',
    'WorkingDirectory=/opt/gtlock-middleware/current',
    'ExecStart=/usr/bin/node /opt/gtlock-middleware/current/dist/main.js',
    'EnvironmentFile=/etc/gtlock-middleware/gtlock.env',
    'LoadCredential=command-api-key:/etc/gtlock-middleware/credentials/command-api-key',
    'LoadCredential=database-url:/etc/gtlock-middleware/credentials/database-url',
    'LoadCredential=redis-url:/etc/gtlock-middleware/credentials/redis-url',
    'StateDirectory=gtlock-middleware', 'Restart=always', 'RestartSec=5',
    'RestartPreventExitStatus=78', 'KillSignal=SIGTERM',
    'After=network-online.target valkey.service', 'Wants=network-online.target',
    'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
    'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes', 'ProtectControlGroups=yes',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    'RestrictNamespaces=yes', 'LockPersonality=yes', 'UMask=0077',
  ]) expect(lines).toContain(line);
  const timeout = /^TimeoutStopSec=(\d+)$/m.exec(unit);
  expect(timeout).not.toBeNull();
  expect(Number(timeout?.[1])).toBeGreaterThan(25);
  expect(unit).not.toMatch(/^(?:ExecStart|Environment)=.*(?:COMMAND_API_KEY|DATABASE_URL|REDIS_URL)/m);
});

test('el despliegue versionado no contiene valores de secretos', () => {
  const env = deploy('gtlock-middleware.env.example');
  expect(env).not.toMatch(/^(?:COMMAND_API_KEY|DATABASE_URL|REDIS_URL)=/m);
  expect(env).toContain('AUDIT_LOG_DIR=/var/lib/gtlock-middleware/audit');
  const valkey = deploy('valkey-gtlock.conf');
  for (const directive of [
    'bind 127.0.0.1 -::1', 'protected-mode yes', 'port 6379',
    'appendonly yes', 'maxmemory-policy noeviction',
    'include /etc/valkey/gtlock-auth.conf',
  ]) expect(valkey.split(/\r?\n/)).toContain(directive);
  expect(valkey).not.toMatch(/^requirepass\s+/m);
  const readme = deploy('README.md');
  expect(readme).toContain('openssl rand -hex 32');
  expect(readme).toContain('valkey-cli --askpass');
  for (const filename of readdirSync(deployDir)) {
    const content = deploy(filename);
    expect(content).not.toMatch(/(?:redis|rediss|postgres|postgresql):\/\/[^\s<]*:[^\s<@]{12,}@/i);
    expect(content).not.toMatch(/^(?:COMMAND_API_KEY|DATABASE_URL|REDIS_URL)\s*=\s*\S+/m);
  }
});
