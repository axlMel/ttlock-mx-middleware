import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import releaseContents from '../../scripts/release-contents.cjs';
const { releaseEntries, nativeModules } = releaseContents;

test('la lista del artefacto contiene únicamente los cinco elementos permitidos', () => {
  expect(releaseEntries()).toEqual(['dist', 'package.json', 'package-lock.json', 'node_modules', 'deploy']);
  expect(releaseEntries()).not.toEqual(expect.arrayContaining(['src', 'specs', 'legacy', '.env', 'audit', 'release']));
  const copy = releaseEntries();
  copy.push('src');
  expect(releaseEntries()).not.toContain('src');
});

test('detecta un módulo nativo antes de crear el artefacto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gtlock-native-test-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'binding.node'), '');
    expect(await nativeModules(root)).toEqual([join(root, 'nested', 'binding.node')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
