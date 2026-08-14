// @vitest-environment node
//
// Exercises the REAL OutputRenderer DOM (see tests/createDomRuntime.ts). These
// verify behaviours that the plain (DOM-less) runtime can't: actual rendered
// HTML, popup menus opened from a right-click, and in-place re-renders.
//
// One runtime is shared across the file (beforeAll/afterAll) — each DOM runtime
// pairs a wasmoon Lua state with a happy-dom Window, and spinning up a fresh
// pair per test accumulates enough memory to get the worker OOM-killed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDomRuntime, type DomTestRuntime } from '../createDomRuntime';

let env: DomTestRuntime;
beforeAll(async () => { env = await createDomRuntime(); });
afterAll(async () => {
  // The popup menu schedules `setTimeout(() => document.addEventListener(...), 0)`
  // for its dismiss handler. Let that 0ms timer fire (while `document` still
  // exists) BEFORE dispose() tears the DOM globals down — otherwise it runs
  // post-teardown, throws "document is not defined" in a timer callback, and
  // kills the worker.
  await new Promise((r) => setTimeout(r, 0));
  env.dispose();
});
beforeEach(() => {
  // Reset rendered output + the main console buffer between tests.
  env.controls.clear();
  env.session.consoles.get('main')?.clear();
  env.mainOutput.length = 0;
});

function lineEls(): Element[] {
  return [...env.outputWrapper.querySelectorAll('.output-msg .output-msg-content')];
}

describe('OutputRenderer DOM — basic echo', () => {
  it('renders an echoed line into the output wrapper', () => {
    env.run('cecho("<red>hello<reset>\\n")');
    expect(lineEls().map((e) => e.textContent)).toEqual(['hello']);
  });
});

describe('wrapLine — in-place DOM re-render', () => {
  it('re-renders a line whose buffer changed without a render, interpreting \\n', () => {
    env.run('cecho("hello\\n")');
    expect(lineEls()[0].textContent).toBe('hello');

    // Mutate the rendered line's buffer directly WITHOUT re-rendering — this is
    // the situation wrapLine exists for (e.g. an edit made mid-trigger where the
    // render is deferred). The DOM is now stale.
    const main = env.session.consoles.get('main')!;
    main.getBuffer()!.insert(5, '\nworld', {});
    expect(lineEls()[0].textContent).toBe('hello'); // still stale

    // wrapLine re-renders the shared buffer in place; pre-wrap shows the \n.
    expect(env.run('return (wrapLine("main", getLineCount() - 1))')).toBe(true);
    expect(lineEls()[0].textContent).toBe('hello\nworld');
  });
});

describe('setProfileStyleSheet — installs a <style> block in document.head', () => {
  // The tags are keyed per connection (and stamped with data-mudix-style-owner)
  // so a closed profile's CSS can be torn down instead of following the tab into
  // the next profile — look them up by kind rather than a fixed global id.
  const profileTags = () =>
    [...env.body.ownerDocument.querySelectorAll('style[data-mudix-profile-stylesheet]')] as HTMLStyleElement[];

  it('creates a single profile-keyed style tag and replaces its content on re-call', () => {
    expect(env.run('return (setProfileStyleSheet(".foo { color: red; }"))')).toBe(true);
    const el = profileTags()[0];
    expect(el).toBeTruthy();
    expect(el.tagName).toBe('STYLE');
    expect(el.parentElement).toBe(env.body.ownerDocument.head);
    expect(el.textContent).toBe('.foo { color: red; }');
    // Owned by this profile, so destroy() can find it.
    expect(el.dataset.mudixStyleOwner).toBeTruthy();

    // A second call replaces the content in place — no duplicate tag.
    env.run('setProfileStyleSheet(".bar { color: blue; }")');
    expect(profileTags().length).toBe(1);
    expect(profileTags()[0].textContent).toBe('.bar { color: blue; }');

    // It's distinct from the setAppStyleSheet block (both coexist).
    env.run('setAppStyleSheet(".app { margin: 0; }")');
    expect(profileTags().length).toBe(1);
    expect(profileTags()[0].textContent).toBe('.bar { color: blue; }');
    const appTags = env.body.ownerDocument.querySelectorAll('style[data-mudix-app-stylesheet]');
    expect(appTags.length).toBe(1);
  });

  it('rewrites Qt objectName selectors so package CSS reaches the DOM', () => {
    // The real-world case: a package that embeds the mapper collapses
    // dlgMapper's control bar by objectName. `QWidget#widget_panel` parses as
    // valid CSS but matches nothing, so it has to be redirected onto the
    // data-qt-object hook MapPanel renders.
    env.run('setProfileStyleSheet("QWidget#widget_panel { max-height: 0px; }")');
    const css = profileTags()[0].textContent ?? '';
    expect(css).toContain('[data-qt-object="widget_panel"]');
    expect(css).not.toContain('QWidget#');
    env.run('setProfileStyleSheet("")');
  });

  it('gives setAppStyleSheet the same scope and Qt bridge as setProfileStyleSheet', () => {
    // Mudlet separates the two because one QApplication hosts several profiles.
    // A mudix tab hosts one, so both are profile-local and profile-owned —
    // identical in scope, differing only in which tag they replace. Anything
    // else would leave a closed profile's CSS restyling the next one opened.
    env.run('setAppStyleSheet("QDockWidget::title { background: #b8731b; }")');
    env.run('setProfileStyleSheet("QDockWidget::title { background: #b8731b; }")');
    const appTag = env.body.ownerDocument
      .querySelector('style[data-mudix-app-stylesheet]') as HTMLStyleElement;
    expect(appTag.textContent).toBe(profileTags()[0].textContent);
    expect(appTag.textContent).toContain('.script-window-titlebar');
    expect(appTag.dataset.mudixStyleOwner).toBe(profileTags()[0].dataset.mudixStyleOwner);
    env.run('setAppStyleSheet("")');
    env.run('setProfileStyleSheet("")');
  });

  // sysAppStyleSheetChange announces an *application*-level change and carries
  // (tag, profileName). A profile sheet is not an application-level change, so
  // setProfileStyleSheet raises nothing — UI_spec asserts both halves.
  it('raises no sysAppStyleSheetChange, unlike setAppStyleSheet', () => {
    // Wire api → runtime event routing exactly as ScriptingEngine does (the
    // bare test runtime doesn't set this up). Restored after the assertion.
    const baseHost = env.api.engineHost;
    env.api.setHost({
      ...baseHost,
      raiseEvent: (event, args) => env.rt.emitEvent(event, args),
    });
    env.run([
      'seen = {}',
      'registerAnonymousEventHandler("sysAppStyleSheetChange", function(_, tag, profile)',
      '  seen[#seen + 1] = { tag = tag, profile = profile }',
      'end)',
      'setProfileStyleSheet(".x { top: 0; }")',
    ].join('\n'));
    expect(env.run('return #seen')).toBe(0);

    env.run('setAppStyleSheet(".y { top: 1; }", "theme")');
    expect(env.run('return #seen')).toBe(1);
    expect(env.run('return seen[1].tag')).toBe('theme');
    env.api.setHost(baseHost);
  });
});

describe('echoPopup — right-click menu in the real DOM', () => {
  it('opens a popup on contextmenu and runs the chosen command', () => {
    env.run('clicked = nil');
    env.run('echoPopup("look\\n", {"clicked = \\"statue\\""}, {"Look at statue"})');

    // The clickable segment span (carries the contextmenu handler) is marked
    // data-output-clickable; the outer .output-msg-content span is not.
    const span = env.outputWrapper.querySelector('[data-output-clickable="true"]');
    expect(span).toBeTruthy();
    expect(span!.textContent).toBe('look');

    // No menu until the user right-clicks.
    expect(env.body.querySelector('#mudix-popup-menu')).toBeNull();
    span!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));

    const menu = env.body.querySelector('#mudix-popup-menu');
    expect(menu).toBeTruthy();
    const items = [...menu!.querySelectorAll('div')];
    expect(items.map((i) => i.textContent)).toEqual(['Look at statue']);

    // Choosing the entry runs its command (wired to run as Lua).
    items[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(env.run('return clicked')).toBe('statue');
  });
});
