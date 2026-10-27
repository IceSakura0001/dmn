import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

test('installed SDK profile composition has no enabled native tool producers, descendants or retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-profile-'));
  try {
    const cli = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib', 'bin.js');
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dir };
    delete env.DEEPSEEK_API_KEY;
    const result = spawnSync(process.execPath, [cli, '--profile','sdk-minimal','--patch','config/runtime.cordis.patch.yml','--dump-config'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, 'The pinned SDK profile must compose successfully');
    const entries = parse(result.stdout, { logLevel: 'silent' }) as { id: string; name: string; disabled?: boolean; config?: Record<string, unknown> }[];
    for (const entry of entries) {
      if (/dsh-tool-|dsh-subagent|dsh-mcp-|dsh-terminal|dsh-subprocess|dsh-llm-retry|dsh-compaction/.test(entry.name)) assert.equal(entry.disabled, true, entry.id);
    }
    const provider = entries.find(row => row.id === 'llm-deepseek')!;
    assert.equal(provider.config?.thinking, 'disabled');
    assert.deepEqual(provider.config?.retryPolicy, { mode: 'normal', maxRetries: 0 });
    assert.equal(provider.config?.defaultContextWindow, 32768);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
