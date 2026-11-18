'use strict';

const { readdir } = require('node:fs/promises');
const { join } = require('node:path');

// Lista cerrada: no incorporar otros archivos del repositorio al artefacto.
function releaseEntries() {
  return ['dist', 'package.json', 'package-lock.json', 'node_modules', 'deploy'];
}

async function nativeModules(directory) {
  const found = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.name.endsWith('.node')) found.push(child);
      if (entry.isDirectory()) await visit(child);
    }
  }
  await visit(directory);
  return found;
}

module.exports = { releaseEntries, nativeModules };
