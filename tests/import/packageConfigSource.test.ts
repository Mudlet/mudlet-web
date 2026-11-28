// @vitest-environment node

// setPackageInfo saves a package's details to its config.lua (Package_spec
// "saves what it sets for a package from an archive to be there after a
// restart"), so what it writes has to read back as exactly what was set —
// keys that are not identifiers, Lua keywords and `_G` included.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';
import { packageConfigSource, parseConfigLuaText } from '../../src/import/packageInstaller';

describe('packageConfigSource', () => {
  let env: TestRuntime;
  beforeAll(async () => { env = await createTestRuntime(); });
  afterAll(() => env.dispose());

  const details = {
    mpackage: 'pkg',
    version: '2.0',
    'spec-hash': 'a]]b"c\\d\ne\r\x01f]',
    end: 'a Lua keyword',
    'end\n': 'a Lua keyword and a newline',
    globals: 'not a table',
    _G: 'not a table either',
    title: 'café ☕',
  };

  it('reads back as the details it was given', () => {
    const read = env.rt.readPackageConfig!(packageConfigSource('pkg', details));
    expect(read).toEqual({ ok: true, info: details });
  });

  it('keeps the plain details readable by the pattern pass too', () => {
    const parsed = parseConfigLuaText(packageConfigSource('pkg', { mpackage: 'pkg', version: '1.2' }));
    expect(parsed.declaredInfo).toEqual({ mpackage: 'pkg', version: '1.2' });
  });
});
