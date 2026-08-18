// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

/**
 * Mudlet validates the BODY of every perm* object with reportInvalidLuaCodeParam
 * (TLuaInterpreter.cpp), which is two checks in one:
 *
 *   lua_isstring(L, index)  -> a NUMBER is an acceptable argument, a table or a
 *                              boolean is not;
 *   luaL_loadbuffer(...)    -> and the string it yields must COMPILE.
 *
 * That second half is the one worth pinning. `permAlias(name, "", "^x$", 999)`
 * is refused not because 999 is a number but because "999" is not a chunk — so a
 * type check alone accepts it and files a body that can never run under a
 * pattern that will keep matching. Bridge.lua once refused it for the wrong
 * reason (a strict `type(code) ~= 'string'`), which meant the coercion sweep in
 * `coercedArgs.test.ts` silently took the rejection away with nothing behind it;
 * Mudlet's own Alias_spec and KeyBinds_spec caught it, and these cases keep the
 * two halves from drifting apart again.
 *
 * The index each function reports is part of the contract — it is how a script
 * author finds the offending argument — and permKey's moves, because Mudlet
 * decides by argument count whether #3 was a modifier or the key code.
 *
 * No engine host is wired into this runtime, so a body that PASSES validation
 * goes on to fail at creation ("cannot create ... (parent not found)"). That is
 * the point of the `not.toThrow(/bad argument/)` cases below: reaching the
 * creation stage at all proves the check let a real chunk through. Creation
 * itself is covered against the live app by the busted corpus.
 */
describe('perm* Lua-code validation parity', () => {
  let t: TestRuntime;
  const run = (code: string) => t.run(code);

  beforeAll(async () => { t = await createTestRuntime(); });
  afterAll(() => t?.dispose());

  // fn -> the call, and the argument index Mudlet reports for its body.
  const bodyAt: [string, (body: string) => string, number][] = [
    ['permAlias',                    b => `permAlias("V", "", "^x$", ${b})`,                     4],
    ['permRegexTrigger',             b => `permRegexTrigger("V", "", {"^x$"}, ${b})`,            4],
    ['permSubstringTrigger',         b => `permSubstringTrigger("V", "", {"x"}, ${b})`,          4],
    ['permBeginOfLineStringTrigger', b => `permBeginOfLineStringTrigger("V", "", {"x"}, ${b})`,  4],
    ['permExactMatchTrigger',        b => `permExactMatchTrigger("V", "", {"x"}, ${b})`,         4],
    ['permPromptTrigger',            b => `permPromptTrigger("V", "", ${b})`,                    3],
    ['permTimer',                    b => `permTimer("V", "", 1, ${b})`,                         4],
    ['permScript',                   b => `permScript("V", "", ${b})`,                           3],
    ['setScript',                    b => `setScript("V", ${b})`,                                2],
  ];

  describe('a body that will not compile is refused', () => {
    for (const [name, call, index] of bodyAt) {
      it(`${name} reports it at argument #${index}`, () => {
        expect(() => run(call('999')))
          .toThrow(`${name}: bad argument #${index} (invalid Lua code:`);
      });
    }

    it('permKey reports #4 in the four-argument form and #5 once a modifier takes #3', () => {
      // Mudlet: `if (lua_gettop(L) > 4) { ...; argIndex++ }` before validating
      // at ++argIndex, so the SAME bad body is named differently by arity.
      expect(() => run('permKey("V", "", 16777264, 42)'))
        .toThrow(/permKey: bad argument #4 \(invalid Lua code:/);
      expect(() => run('permKey("V", "", 2, 16777264, 42)'))
        .toThrow(/permKey: bad argument #5 \(invalid Lua code:/);
    });
  });

  describe('a body that is not string-coercible at all is refused first', () => {
    for (const [name, call, index] of bodyAt) {
      it(`${name} names the type at argument #${index}`, () => {
        expect(() => run(call('{}')))
          .toThrow(`${name}: bad argument #${index} (lua script as string expected, got table!)`);
      });
    }
  });

  describe('the pattern list is checked before the body, in Mudlet\'s words', () => {
    // Mudlet checks argument #3 with lua_istable and raises before it ever looks
    // at the body, so a call that is wrong in BOTH places reports the list.
    // The noun is not uniform upstream — permExactMatchTrigger names its list
    // differently from the other three — and it is copied rather than smoothed
    // over, because the text is the part a script matches on.
    const listNoun: [string, string][] = [
      ['permRegexTrigger',             'sub-strings list'],
      ['permSubstringTrigger',         'sub-strings list'],
      ['permBeginOfLineStringTrigger', 'sub-strings list'],
      ['permExactMatchTrigger',        'exact match patterns list'],
    ];
    for (const [name, what] of listNoun) {
      it(`${name} calls it a ${what}`, () => {
        expect(() => run(`${name}("V", "", "not a table", 999)`))
          .toThrow(`${name}: bad argument #3 type (${what} as table expected, got string!)`);
      });
    }
  });

  describe('a real chunk still gets through', () => {
    // Throwing something OTHER than a bad-argument error is the pass condition
    // here — see the note above about the missing engine host.
    for (const [name, call] of bodyAt) {
      it(`${name} accepts a compiling body`, () => {
        expect(() => run(call('[[echo("ok")]]'))).not.toThrow(/bad argument/);
      });
    }

    it('an empty body compiles, so permGroup can keep building folders with it', () => {
      // permGroup (Other.lua) makes every folder type by handing the matching
      // perm* an empty body, so "" has to stay valid Lua for all of them.
      for (const [name, call] of bodyAt) {
        expect(() => run(call('""')), name).not.toThrow(/bad argument/);
      }
    });
  });
});
