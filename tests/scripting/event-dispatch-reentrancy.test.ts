// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRuntime, type TestRuntime } from '../createTestRuntime';

// Mudlet parity (Host::raiseEvent): an event raised while another event is
// still dispatching runs its handlers immediately, inside the raise — so the
// raiser sees their side effects as soon as raiseEvent returns (issue #172).
//
// Regression guarded alongside it: EleUI2's install flow. installPackage(url)
// downloads the .mpackage; the sysDownloadDone handler installs the package,
// whose init raises sysInstallPackage; that handler runs the package's
// GitUpdater, which registers its own sysDownloadDone handler. That new handler
// must not receive the in-flight sysDownloadDone — GitUpdater took the
// package's own install download for a finished update and uninstalled the
// package it belonged to. Handler lists are snapshotted per dispatch for that.
describe('event dispatch — events raised mid-dispatch run synchronously', () => {
  let t: TestRuntime;
  let errors: string[];
  let off: () => void;

  beforeEach(async () => {
    t = await createTestRuntime();
    errors = [];
    off = t.session.events.on('script.log', (text: string, level: string) => {
      if (level === 'error') errors.push(text);
    });
  });

  afterEach(() => {
    off();
    t.dispose();
  });

  it('raiseEvent inside a handler dispatches before raiseEvent returns', () => {
    t.run(`
      order = {}
      registerAnonymousEventHandler('outerEvt', function()
        order[#order + 1] = 'outer-begin'
        raiseEvent('innerEvt')
        order[#order + 1] = 'outer-end'
      end)
      registerAnonymousEventHandler('innerEvt', function()
        order[#order + 1] = 'inner'
      end)
    `);
    t.rt.emitEvent('outerEvt', []);
    expect(t.run(`return table.concat(order, ',')`)).toBe('outer-begin,inner,outer-end');
    expect(errors).toHaveLength(0);
  });

  it('state a nested handler sets is visible to the raiser', () => {
    t.run(`
      registerAnonymousEventHandler('evtOuter', function()
        raiseEvent('evtInner'); seenFlag = FLAG
      end)
      registerAnonymousEventHandler('evtInner', function() FLAG = true end)
      raiseEvent('evtOuter')
    `);
    expect(t.run('return seenFlag')).toBe(true);
  });

  it('a handler killed earlier in the same dispatch is not called', () => {
    t.run(`
      calls = {}
      local victim
      registerAnonymousEventHandler('killEvt', function()
        calls[#calls + 1] = 'killer'; killAnonymousEventHandler(victim)
      end)
      victim = registerAnonymousEventHandler('killEvt', function() calls[#calls + 1] = 'victim' end)
      raiseEvent('killEvt')
    `);
    expect(t.run(`return table.concat(calls, ',')`)).toBe('killer');
  });

  it('raiseEvent inside a handler returns true', () => {
    t.run(`
      registerAnonymousEventHandler('retOuter', function() nestedRet = raiseEvent('retInner') end)
      raiseEvent('retOuter')
    `);
    expect(t.run('return nestedRet')).toBe(true);
  });

  it('nested events dispatch in order with their arguments', () => {
    t.run(`
      got = {}
      registerAnonymousEventHandler('fifoOuter', function()
        raiseEvent('fifoChild', 'first')
        raiseEvent('fifoChild', 'second')
      end)
      registerAnonymousEventHandler('fifoChild', function(_, arg)
        got[#got + 1] = arg
      end)
    `);
    t.rt.emitEvent('fifoOuter', []);
    expect(t.run(`return table.concat(got, ',')`)).toBe('first,second');
    expect(errors).toHaveLength(0);
  });

  it('a handler registered from a nested event does not receive the in-flight event', () => {
    // Mirrors the EleUI2 flow: 'download' handler triggers a nested 'install'
    // event whose handler registers a NEW 'download' handler (GitUpdater).
    // That handler must not be called with the download that installed it.
    t.run(`
      updaterSeen = {}
      registerAnonymousEventHandler('download', function()
        raiseEvent('install')
      end)
      registerAnonymousEventHandler('install', function()
        registerAnonymousEventHandler('download', function(_, path)
          updaterSeen[#updaterSeen + 1] = path
        end)
      end)
    `);
    t.rt.emitEvent('download', ['EleUI2.mpackage']);
    expect(t.run('return #updaterSeen')).toBe(0);

    // A later download IS seen by the updater handler.
    t.rt.emitEvent('download', ['update.mpackage']);
    expect(t.run('return updaterSeen[1]')).toBe('update.mpackage');
    expect(t.run('return #updaterSeen')).toBe(1);
    expect(errors).toHaveLength(0);
  });
});

// Regression: a freshly-installed default/brand package's sysInstallPackage
// handler can be silently undone by that same package's own sysLoadEvent
// handler, if sysLoadEvent fires afterward. Real-world case (EleUI2): a
// sysInstallPackage handler calls Adjustable.Container:attachToBorder(...),
// but the package's sysLoadEvent handler calls Adjustable.Container.load(),
// which restores a saved snapshot captured before the container was ever
// attached — unconditionally detaching it again. ScriptingEngine.attachToStore
// fires sysLoadEvent before notifying freshly-installed packages of their
// install specifically so a package's own install-time setup is the last
// word, not the load-time restore. This test pins that ordering contract at
// the event-dispatch level (independent of the full VFS/store bootstrap).
describe('event dispatch — install-then-load ordering can clobber install setup', () => {
  let t: TestRuntime;

  beforeEach(async () => { t = await createTestRuntime(); });
  afterEach(() => t.dispose());

  it('firing sysLoadEvent before sysInstallPackage preserves install-time setup', () => {
    t.run(`
      attached = false
      registerAnonymousEventHandler('sysLoadEvent', function()
        -- Mirrors Adjustable.Container.load(): restores a pre-install
        -- snapshot, unconditionally clearing the attached flag.
        attached = false
      end)
      registerAnonymousEventHandler('sysInstallPackage', function()
        attached = true
      end)
    `);
    t.rt.emitEvent('sysLoadEvent', []);
    t.rt.emitEvent('sysInstallPackage', ['EleUI2']);
    expect(t.run('return attached')).toBe(true);
  });

  it('firing sysInstallPackage before sysLoadEvent lets the load handler clobber it', () => {
    t.run(`
      attached = false
      registerAnonymousEventHandler('sysLoadEvent', function()
        attached = false
      end)
      registerAnonymousEventHandler('sysInstallPackage', function()
        attached = true
      end)
    `);
    t.rt.emitEvent('sysInstallPackage', ['EleUI2']);
    t.rt.emitEvent('sysLoadEvent', []);
    expect(t.run('return attached')).toBe(false);
  });
});
