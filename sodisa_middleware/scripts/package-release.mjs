import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import releaseContents from './release-contents.cjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { releaseEntries, nativeModules } = releaseContents;

function run(command, args, cwd, capture = false, shell = false) {
  const result = spawnSync(command, args, { cwd, encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit', shell });
  if (result.error || result.status !== 0) {
    throw new Error(`Falló ${basename(command)} ${args[0] ?? ''}.`);
  }
  return capture ? result.stdout.trim() : '';
}

function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli) return run(process.execPath, [cli, ...args], cwd);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, false, process.platform === 'win32');
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^[A-Za-z0-9._-]+$/.test(pkg.version)) throw new Error('Versión inválida en package.json.');
  const commit = run('git', ['rev-parse', '--short', 'HEAD'], root, true);
  if (!/^[0-9a-f]+$/.test(commit)) throw new Error('Commit de Git inválido.');
  const dirty = run('git', ['status', '--porcelain'], root, true).length > 0;
  if (dirty) process.stderr.write('Aviso: el árbol de trabajo tiene cambios; el artefacto llevará -dirty.\n');
  const name = `gtlock-middleware-${pkg.version}-${commit}${dirty ? '-dirty' : ''}`;
  const temporary = await mkdtemp(join(tmpdir(), 'gtlock-release-'));
  const temporaryRoot = resolve(tmpdir());
  if (!resolve(temporary).startsWith(`${temporaryRoot}${sep}`) || !basename(temporary).startsWith('gtlock-release-')) {
    throw new Error('Directorio temporal fuera de la ruta permitida.');
  }
  try {
    // Compilar en un destino nuevo evita empaquetar salidas antiguas de dist/.
    npm(['run', 'build', '--', '--outDir', join(temporary, 'dist')], root);
    await copyFile(join(root, 'package.json'), join(temporary, 'package.json'));
    await copyFile(join(root, 'package-lock.json'), join(temporary, 'package-lock.json'));
    npm(['ci', '--omit=dev', '--omit=optional', '--ignore-scripts'], temporary);
    await cp(join(root, 'deploy'), join(temporary, 'deploy'), { recursive: true });
    const native = await nativeModules(join(temporary, 'node_modules'));
    if (native.length) throw new Error('El artefacto contiene módulos *.node; revisar dependencias de producción.');
    const tarName = `${name}.tar.gz`;
    const temporaryTar = join(temporaryRoot, `${name}-${process.pid}.tar.gz`);
    try {
      run('tar', ['-czf', temporaryTar, '-C', temporary, ...releaseEntries()], root);
      const sha = await digest(temporaryTar);
      const output = join(root, 'release');
      await mkdir(output, { recursive: true });
      await rename(temporaryTar, join(output, tarName));
      await writeFile(join(output, `${tarName}.sha256`), `${sha}  ${tarName}\n`, 'utf8');
      process.stdout.write(`Artefacto creado: ${join(output, tarName)}\n`);
    } finally {
      await rm(temporaryTar, { force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
