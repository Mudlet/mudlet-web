// @vitest-environment node
//
// Regression for trigger firing order. Mudlet keeps permanent and temporary
// triggers in one ordered list (`mTriggerRootNodeList`) and fires them
// front-to-back; a temp created at runtime is appended after the permanent
// triggers that already exist, so a permanent trigger on a line fires BEFORE a
// later-created temp that also matches it. Mudlet Web used to run all temps first,
// then all perms — which drove the Arkadia "deposit" double-print: the temp
// (boxes.lua update_box) ran before the permanent container trigger, nulled the
// guard, and made the permanent trigger re-run update_box.

import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerEngine, type TriggerNode } from '../../src/mud/triggers/TriggerEngine';

function trig(over: Partial<TriggerNode> & { id: string; patterns: TriggerNode['patterns'] }): TriggerNode {
  return {
    name: over.id,
    enabled: true,
    isGroup: false,
    parentId: null,
    code: 'x',
    language: 'lua',
    fireLength: 0,
    multipleMatches: false,
    multiline: false,
    delta: 0,
    isFilter: false,
    ...over,
  } as TriggerNode;
}

describe('TriggerEngine unified perm/temp ordering', () => {
  let te: TriggerEngine;
  beforeEach(async () => { await TriggerEngine.ready(); te = new TriggerEngine(); });

  it('fires a permanent trigger before a temp created afterwards on the same line', () => {
    const order: string[] = [];
    te.loadPerm([trig({ id: 'perm', patterns: [{ type: 'regex', text: 'depozyt' }] })]);
    te.addTemp('depozyt', () => order.push('temp'), 'regex');

    te.process('twoj depozyt zawiera cos', false, (m) => order.push(`perm:${m.trigger.id}`));

    expect(order).toEqual(['perm:perm', 'temp']);
  });

  it('fires temps in creation order, after the permanent trigger', () => {
    const order: string[] = [];
    te.loadPerm([trig({ id: 'perm', patterns: [{ type: 'regex', text: 'x' }] })]);
    te.addTemp('x', () => order.push('temp1'), 'substring');
    te.addTemp('x', () => order.push('temp2'), 'substring');

    te.process('x', false, () => order.push('perm'));

    expect(order).toEqual(['perm', 'temp1', 'temp2']);
  });

  it('places a permanent trigger added at runtime AFTER an already-existing temp', () => {
    const order: string[] = [];
    te.loadPerm([trig({ id: 'p1', patterns: [{ type: 'regex', text: 'x' }] })]);
    te.addTemp('x', () => order.push('temp'), 'substring');
    // Runtime package install: a new permanent node appears in a later load.
    te.loadPerm([
      trig({ id: 'p1', patterns: [{ type: 'regex', text: 'x' }] }),
      trig({ id: 'p2', patterns: [{ type: 'regex', text: 'x' }] }),
    ]);

    te.process('x', false, (m) => order.push(`perm:${m.trigger.id}`));

    // p1 (loaded first) → temp (created next) → p2 (loaded last).
    expect(order).toEqual(['perm:p1', 'temp', 'perm:p2']);
  });

  it('keeps a child trigger after its parent group even when re-parented late', () => {
    const order: string[] = [];
    // child 'c' exists first at root; later it is moved under a freshly-created
    // group 'g'. Despite the child's lower seq, the path leads with the group's
    // seq, so the group still fires before its child.
    te.loadPerm([trig({ id: 'c', patterns: [{ type: 'regex', text: 'x' }] })]);
    te.loadPerm([
      trig({ id: 'g', isGroup: true, patterns: [{ type: 'regex', text: 'x' }] }),
      trig({ id: 'c', parentId: 'g', patterns: [{ type: 'regex', text: 'x' }] }),
    ]);

    te.process('x', false, (m) => order.push(m.trigger.id));

    expect(order).toEqual(['g', 'c']);
  });
});
