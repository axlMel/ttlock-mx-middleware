import { readFileSync } from 'node:fs';
import { runProcess, realFactories, createConsoleLogger } from './app';
import { loadConfig } from './config';

void runProcess(() => loadConfig(process.env, (path) => readFileSync(path, 'utf8')),
  process, createConsoleLogger(), realFactories);
