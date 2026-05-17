import { css } from 'lit';

//Visual styles for the card configuration editor. Kept in its own
//file (separate from the runtime card's helios-card-css.ts) so a
//styling change to the editor never accidentally affects the card
//rendered on the dashboard, and vice versa. The two surfaces live
//in distinct Shadow DOM trees and share zero selectors, so the
//split is purely organisational, not functional.
//
//Two exports:
//  - colorPickerStyles: applied to the <helios-color-picker>
//    custom element used by every color-picker field in the editor.
//  - editorStyles: applied to the <helios-card-editor> root element
//    that hosts the whole config UI.

export const colorPickerStyles = css`
    :host { position: relative; display: inline-block; }

    .swatch
    {
        width: 44px;
        height: 30px;
        padding: 0;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.2));
        border-radius: 4px;
        cursor: pointer;
        background-clip: padding-box;
    }

    .swatch:focus-visible
    {
        outline: 2px solid var(--primary-color, #03a9f4);
        outline-offset: 2px;
    }

    .pop
    {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 1000;
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color, rgba(0,0,0,0.18));
        border-radius: 6px;
        padding: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        min-width: 220px;
    }

    .grid
    {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 4px;
    }

    .cell
    {
        width: 22px;
        height: 22px;
        border-radius: 3px;
        border: 1px solid rgba(0,0,0,0.12);
        cursor: pointer;
        padding: 0;
    }

    .cell:hover    { transform: scale(1.1); }
    .cell.selected
    {
        outline: 2px solid var(--primary-color, #03a9f4);
        outline-offset: 1px;
    }

    .hex-row
    {
        margin-top: 10px;
        display: flex;
        align-items: center;
        gap: 4px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.18));
        border-radius: 4px;
        padding: 4px 6px;
    }

    .hex-prefix
    {
        color: var(--secondary-text-color, #727272);
        font-family: monospace;
        font-size: 13px;
    }

    .hex-input
    {
        border: none;
        outline: none;
        background: transparent;
        font-family: monospace;
        font-size: 13px;
        width: 100%;
        color: var(--primary-text-color, #212121);
        text-transform: lowercase;
    }
`;


export const editorStyles = css`
    .editor
    {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .section-title
    {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--primary-color, #03a9f4);
        margin-top: 10px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.12));
    }

    /*  Collapsible section. Uses native <details>/<summary> so the
        open/closed state needs no JS plumbing and survives keyboard
        navigation for free. The default disclosure triangle is
        replaced by a custom chevron via ::before so the summary
        row visually matches a regular .section-title heading with a
        single rotating glyph that signals expandability.

        Extra margin-top between sibling sections so they read as
        distinct blocks even when several are collapsed in a row.
        The first child of the editor gets no margin (the editor
        container handles its own top padding).                     */
    details.advanced-section
    {
        display: flex;
        flex-direction: column;
        gap: 14px;
        margin-top: 24px;
    }
    details.advanced-section:first-child { margin-top: 0; }
    details.advanced-section > summary
    {
        list-style: none;
        cursor: pointer;
        user-select: none;
    }
    details.advanced-section > summary::-webkit-details-marker { display: none; }
    details.advanced-section > summary.section-title-collapse
    {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--primary-color, #03a9f4);
        padding-bottom: 6px;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.18));
    }
    details.advanced-section > summary.section-title-collapse::before
    {
        content: '▸';
        display: inline-block;
        font-size: 10px;
        line-height: 1;
        transition: transform 120ms ease-out;
    }
    details.advanced-section[open] > summary.section-title-collapse::before
    {
        transform: rotate(90deg);
    }

    /*  Vertical rhythm: a positive top margin pushes the help
        visibly away from its field above, and a generous bottom
        margin creates a clear break before the next field. Both
        stack with the section's 14 px flex gap, giving:
          field → help        = gap + top    = 14 + 8  = 22 px
          help  → next field  = gap + bottom = 14 + 20 = 34 px
        Hierarchy ratio 1.5×, both spacings comfortable to read.   */
    .field-help
    {
        font-size: 11px;
        color: var(--secondary-text-color, #727272);
        margin: 8px 0 20px 0;
    }

    .field-help a       { color: var(--primary-color, #03a9f4); text-decoration: none; }
    .field-help a:hover { text-decoration: underline; }

    .hint
    {
        font-size: 11px;
        color: var(--secondary-text-color, #727272);
        font-style: italic;
        margin: 8px 0 20px 0;
    }

    .field
    {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        position: relative;
    }

    /*  Extra breathing room between two consecutive fields with no
        help text between them (e.g. the Location lat/lon pair or
        the Local LiDAR bbox quartet). Without it the rows visually
        touch because the section flex gap alone is too tight. The
        selector only fires when both siblings are .field, so cases
        with a .hint or .field-help between still rely on the
        help's own margins.                                          */
    .field + .field
    {
        margin-top: 8px;
    }

    /*  Stacked variant for controls too wide to share a row with
        their label (e.g. ha-entity-picker). */
    .field.field-block
    {
        flex-direction: column;
        align-items: stretch;
        gap: 4px;
    }

    .field.field-block .label             { flex: none; }
    .field.field-block ha-entity-picker   { width: 100%; }

    .label
    {
        font-size: 13px;
        color: var(--primary-text-color, #212121);
        flex: 1;
    }

    input[type="text"],
    input[type="number"]
    {
        width: 180px;
        padding: 6px 8px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        font-size: 13px;
    }

    /*  Native dropdown reused for any setting with 3+ options whose
        labels can't fit a horizontal segmented toggle without
        cropping across languages. Same width budget as the text
        inputs so right-edge alignment matches the rest of the
        editor. The browser's native chevron + dropdown menu is
        kept on purpose: it's the most familiar control on every
        HA frontend (desktop, mobile, iframe). */
    .he-select
    {
        width: 180px;
        padding: 6px 8px;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        font-size: 13px;
    }

    /*  Two-button toggle, sized to match the other inputs so
        the right-edge alignment stays consistent across fields. */
    .segmented-toggle
    {
        display: inline-flex;
        width: 180px;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        background: var(--card-background-color, #fff);
    }

    .seg-option
    {
        flex: 1;
        padding: 7px 10px;
        background: transparent;
        color: var(--primary-text-color, #212121);
        border: none;
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
        transition: background 0.15s, color 0.15s;
    }

    .seg-option + .seg-option
    {
        border-left: 1px solid var(--divider-color, rgba(0,0,0,0.12));
    }

    .seg-option:hover:not(.active)
    {
        background: var(--secondary-background-color, rgba(0,0,0,0.04));
    }

    .seg-option.active
    {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
    }

    /*  Slider variant, replaces type="number" inputs so the
        user can never enter a value outside the supported range.
        The matching value is shown to the right of the track. */
    .slider-row
    {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: 180px;
    }

    .slider-row input[type="range"]
    {
        flex: 1;
        min-width: 0;
        accent-color: var(--primary-color, #03a9f4);
    }

    .slider-value
    {
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        color: var(--secondary-text-color, #727272);
        min-width: 44px;
        text-align: right;
    }

    code
    {
        font-family: monospace;
        background: var(--secondary-background-color, rgba(0,0,0,0.05));
        padding: 1px 4px;
        border-radius: 3px;
    }

    /*  One bordered card per PV array entry. Now a <details> so
        the user can collapse individual arrays once they're set up
        and keep the editor short. The card frame stays whether
        collapsed or expanded so the multi-array config still reads
        as discrete groups rather than a tall undifferentiated list. */
    details.pv-array-card
    {
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 6px;
        background: var(--card-background-color, #fff);
        overflow: hidden;
    }
    details.pv-array-card + details.pv-array-card
    {
        margin-top: 10px;
    }

    /*  Summary = header row of the collapsed/expanded card. Stays
        visible whether the card is open or not; clicking anywhere
        on it toggles. Native marker is hidden, replaced by a
        custom chevron so the rotation is consistent with the
        other collapsible sections above. */
    details.pv-array-card > summary.pv-array-summary
    {
        list-style: none;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        cursor: pointer;
        user-select: none;
    }
    details.pv-array-card > summary.pv-array-summary::-webkit-details-marker { display: none; }
    details.pv-array-card[open] > summary.pv-array-summary
    {
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.08));
    }

    /*  Chevron rotates 90° when the card is open. Same SVG-less
        approach used by the .section-title-collapse arrow so the
        two collapsibles look coherent. */
    .pv-array-chevron
    {
        width: 0;
        height: 0;
        border-style: solid;
        border-width: 4px 0 4px 5px;
        border-color: transparent transparent transparent var(--secondary-text-color, #757575);
        transition: transform 0.15s ease;
        flex-shrink: 0;
    }
    details.pv-array-card[open] > summary.pv-array-summary > .pv-array-chevron
    {
        transform: rotate(90deg);
    }

    .pv-array-title
    {
        font-size: 12px;
        font-weight: 600;
        color: var(--primary-text-color, #212121);
        flex: 1;
    }

    /*  Body of the open card: holds the tilt / azimuth / share
        stacked fields. Padding kept consistent with the previous
        div-card layout. */
    .pv-array-body
    {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
    }

    /*  Borderless text buttons for add/remove so the cards stay
        visually quiet. The +Add button gets the accent colour to
        telegraph the affordance, Remove stays muted (destructive
        actions don't need to shout; they're behind a disabled
        state when there's only one card). */
    .pv-array-add,
    .pv-array-remove
    {
        background: transparent;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        color: var(--primary-text-color, #212121);
    }

    /*  "+ Add array" button: right-aligned at the bottom of the
        section. Block element with margin-left: auto and
        fit-content width pulls it to the right without depending
        on the parent being a flex container (the outer <details>
        isn't). */
    .pv-array-add
    {
        color: var(--primary-color, #03a9f4);
        border-color: var(--primary-color, #03a9f4);
        display: block;
        margin-left: auto;
        margin-top: 8px;
        width: fit-content;
    }

    .pv-array-remove:disabled
    {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .pv-array-add:hover:not(:disabled),
    .pv-array-remove:hover:not(:disabled)
    {
        background: var(--secondary-background-color, rgba(0,0,0,0.04));
    }

    /*  Mirror the focus-visible ring used on .swatch elsewhere
        in the editor so keyboard users get a consistent indicator
        on the new add/remove buttons. */
    .pv-array-add:focus-visible,
    .pv-array-remove:focus-visible
    {
        outline: 2px solid var(--primary-color, #03a9f4);
        outline-offset: 2px;
    }
`;
