#!/usr/bin/env node
/**
 * @fileoverview `npx` entry of the qaFramework installer. It checks the Node
 * version before loading anything else, so an old Node gets a clear message:
 * a static import would be parsed and run before this check.
 */

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `error: Node ${process.versions.node} found, qaFramework needs 22.18 or later`,
  );
  process.exit(1);
}

const {main} = await import('./setup.mjs');
await main(process.argv.slice(2));
