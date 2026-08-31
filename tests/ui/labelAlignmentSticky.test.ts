// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { LabelManager } from '../../src/ui/labels/LabelManager';

// Qt applies `qproperty-alignment` as a *widget property*, not transient style:
// once a stylesheet sets it, a later setStyleSheet that omits it does NOT revert
// it. This is exactly how Adjustable.Container + EleUI2 layer their stylesheets
// — the container installs `AlignLeft | AlignTop` in the default adjLabel style,
// then the EleUI2 theme replaces the whole sheet (border-image frame, negative
// padding) without any alignment, and Mudlet keeps the title top-aligned. mudix
// must do the same, or the title vertically centres in the middle of the frame.
describe('LabelManager qproperty-alignment stickiness', () => {
    function make(): LabelManager {
        const mgr = new LabelManager();
        mgr.create('t', {
            x: 0, y: 0, width: 100, height: 100, fillBackground: false,
        });
        return mgr;
    }

    it('captures the alignment from a stylesheet that declares it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', "border: 0; qproperty-alignment: 'AlignLeft | AlignTop';");
        expect(mgr.list('main')[0].alignment).toBe('AlignLeft | AlignTop');
    });

    it('keeps the alignment when a later stylesheet omits it', () => {
        const mgr = make();
        // 1) Adjustable.Container's default adjLabel style installs the alignment.
        mgr.setStyleSheet('t', "qproperty-alignment: 'AlignLeft | AlignTop';");
        // 2) EleUI2 replaces the whole sheet with its frame — no alignment.
        mgr.setStyleSheet('t',
            'border-top: 85px solid transparent; border-image: url(UI_Window.png) fill; padding-top: -95px;');
        const lbl = mgr.list('main')[0];
        expect(lbl.styleSheet).toContain('UI_Window.png');
        expect(lbl.alignment).toBe('AlignLeft | AlignTop'); // sticky
    });

    it('updates the alignment when a later stylesheet declares a new one', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'qproperty-alignment: AlignTop;');
        mgr.setStyleSheet('t', 'qproperty-alignment: AlignBottom;');
        expect(mgr.list('main')[0].alignment).toBe('AlignBottom');
    });

    it('leaves alignment unset when no stylesheet ever declared one', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'border-image: url(bg.png);');
        expect(mgr.list('main')[0].alignment).toBeUndefined();
    });
});

// qproperty-scaledContents is the same kind of sticky Qt widget property as
// alignment: it makes setBackgroundImage stretch to fill the label (issue #9),
// and persists across a later setStyleSheet that omits it.
describe('LabelManager qproperty-scaledContents stickiness', () => {
    function make(): LabelManager {
        const mgr = new LabelManager();
        mgr.create('t', {
            x: 0, y: 0, width: 100, height: 100, fillBackground: false,
        });
        return mgr;
    }

    it('captures scaledContents from a stylesheet that declares it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'padding: 6px; qproperty-scaledContents: true;');
        expect(mgr.list('main')[0].scaledContents).toBe(true);
    });

    it('keeps scaledContents when a later stylesheet omits it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'qproperty-scaledContents: true;');
        mgr.setStyleSheet('t', 'padding: 6px;');
        expect(mgr.list('main')[0].scaledContents).toBe(true); // sticky
    });

    it('updates scaledContents when a later stylesheet flips it off', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'qproperty-scaledContents: true;');
        mgr.setStyleSheet('t', 'qproperty-scaledContents: false;');
        expect(mgr.list('main')[0].scaledContents).toBe(false);
    });

    it('leaves scaledContents unset when no stylesheet ever declared it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'border-image: url(bg.png);');
        expect(mgr.list('main')[0].scaledContents).toBeUndefined();
    });
});

// qproperty-wordWrap is the third sticky Qt widget property a label stylesheet
// can carry. QLabel::wordWrap is false by default and TLabel never sets it, so
// Mudlet lays label text out with QTextOption::ManualWrap — it runs past the
// widget edge and gets clipped rather than folding onto a second line. mudix
// renders that as `white-space: nowrap`, and this property is the opt-out.
describe('LabelManager qproperty-wordWrap stickiness', () => {
    function make(): LabelManager {
        const mgr = new LabelManager();
        mgr.create('t', {
            x: 0, y: 0, width: 100, height: 100, fillBackground: false,
        });
        return mgr;
    }

    it('captures wordWrap from a stylesheet that declares it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'padding-left: 10px; qproperty-wordWrap: true;');
        expect(mgr.list('main')[0].wordWrap).toBe(true);
    });

    it('reads it out of a QLabel ruleset as well as the base block', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'QLabel { qproperty-wordWrap: true; }');
        expect(mgr.list('main')[0].wordWrap).toBe(true);
    });

    it('keeps wordWrap when a later stylesheet omits it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'qproperty-wordWrap: true;');
        mgr.setStyleSheet('t', 'background-color: black;');
        expect(mgr.list('main')[0].wordWrap).toBe(true); // sticky
    });

    it('updates wordWrap when a later stylesheet flips it off', () => {
        const mgr = make();
        mgr.setStyleSheet('t', 'qproperty-wordWrap: true;');
        mgr.setStyleSheet('t', 'qproperty-wordWrap: false;');
        expect(mgr.list('main')[0].wordWrap).toBe(false);
    });

    // The default matters: an unset property is what the `.label` nowrap rule
    // renders, which is what a Mudlet-metrics package (MDW's fixed-width
    // dropdown items) is drawn against.
    it('leaves wordWrap unset when no stylesheet ever declared it', () => {
        const mgr = make();
        mgr.setStyleSheet('t', "font-family: 'Bitstream Vera Sans Mono'; font-size: 11px;");
        expect(mgr.list('main')[0].wordWrap).toBeUndefined();
    });
});
