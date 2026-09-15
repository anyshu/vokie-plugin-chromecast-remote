import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

test('native report normalization preserves IDs and rejects unidentified data without opening HID', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cast-native-test-'));
  try {
    const main = join(dir, 'main.swift');
    await writeFile(main, `
precondition(chromecastButtonReport(reportID: 1, bytes: [7]) == [1, 7])
precondition(chromecastButtonReport(reportID: 1, bytes: [1, 11]) == [1, 11])
precondition(chromecastButtonReport(reportID: 1, bytes: [1]) == [1, 1])
precondition(chromecastButtonReport(reportID: 1, bytes: [0]) == [1, 0])
precondition(chromecastButtonReport(reportID: 0, bytes: [1, 7]) == [1, 7])
precondition(chromecastButtonReport(reportID: 0, bytes: [7]) == nil)
precondition(chromecastButtonReport(reportID: 2, bytes: [1, 7]) == nil)
precondition(chromecastButtonReport(reportID: 1, bytes: []) == nil)
precondition(supportedIdentity(vendor: 0x18d1, product: 0x9450, page: 1, usage: 6))
precondition(supportedIdentity(vendor: 0x18d1, product: 0x9450, page: 12, usage: 1))
precondition(!supportedIdentity(vendor: 0x1234, product: 0x9450, page: 12, usage: 1))
precondition(!supportedIdentity(vendor: 0x18d1, product: 0x1234, page: 12, usage: 1))
precondition(!supportedIdentity(vendor: 0x18d1, product: 0x9450, page: 1, usage: 2))
print("normalization passed")
`);
    const executable = join(dir, 'report-test');
    await exec('swiftc', [fileURLToPath(new URL('../native/HIDReport.swift', import.meta.url)), fileURLToPath(new URL('../native/RemoteIdentity.swift', import.meta.url)), main, '-o', executable]);
    assert.match((await exec(executable)).stdout, /normalization passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
