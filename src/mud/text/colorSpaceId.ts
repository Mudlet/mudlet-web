/**
 * Whether 24-bit SGR colour arrives with a colour-space id.
 *
 * `ESC[38;2;<r>;<g>;<b>m` is what nearly every server sends, but ITU T.416 —
 * the standard the sequence comes from — puts a colour-space id parameter
 * first: `ESC[38;2;<id>;<r>;<g>;<b>m`. The two are not distinguishable from the
 * escape alone, and reading one as the other shifts every channel by a place,
 * so desktop Mudlet makes it a preference ("Expect Color Space Id in
 * SGR...(3|4)8;2;...m codes") rather than guessing. So does this.
 *
 * Module-level for the same reason as {@link getControlCharacterMode}: it is
 * read per escape sequence while parsing every line, one tab renders one
 * profile, and the alternative is threading it through the whole text pipeline.
 * Kept in sync by `MudSession.setExpectColorSpaceId`.
 */
let expectId = false;

export function getExpectColorSpaceId(): boolean {
    return expectId;
}

export function setExpectColorSpaceId(expect: boolean): void {
    expectId = expect;
}
