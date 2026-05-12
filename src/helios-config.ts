import { LitElement, html, css, TemplateResult, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import
{
    type HeliosConfig,
    DEFAULT_SUN_COLOR_HEX,
    DEFAULT_CLOUD_COLOR_HEX,
    DEFAULT_PV_COLOR_HEX,
    DEFAULT_BATTERY_COLOR_HEX,
    DEFAULT_BUILDING_RADIUS_M,
    DEFAULT_BUILDING_OPACITY,
    DEFAULT_BUILDING_CLUSTER_RADIUS_M,
    DEFAULT_BUILDING_COLOR_HEX
} from './helios-engine';
import { pickTranslations, type Translations } from './i18n';


//Validate a config value as a #rrggbb hex string. Falls back to the
//provided default for null, undefined, or malformed input.
export function cfgHex(v: unknown, fallback: string): string
{
    if (v == null)
    {
        return fallback;
    }
    const s = String(v).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s))
    {
        return s;
    }
    return fallback;
}


//Locale-independent date formatter. Tokens: yyyy, yy, mm, dd —
//anything else is preserved verbatim. Falls back to "mm-dd" when
//the format is empty, undefined, or contains unsafe characters.
const VALID_DATE_FORMAT_RE = /^[\-\/\. _:0-9A-Za-z]+$/;
const DATE_TOKEN_RE        = /yyyy|yy|mm|dd/g;

export function formatDate(d: Date, rawFormat: unknown): string
{
    let fmt = typeof rawFormat === 'string' ? rawFormat.trim() : '';
    if (!fmt || !VALID_DATE_FORMAT_RE.test(fmt) || !DATE_TOKEN_RE.test(fmt))
    {
        fmt = 'mm-dd';
    }
    DATE_TOKEN_RE.lastIndex = 0;

    const yyyy = String(d.getFullYear());
    const yy   = yyyy.slice(-2);
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');

    return fmt.replace(DATE_TOKEN_RE, tok =>
    {
        switch (tok)
        {
            case 'yyyy': return yyyy;
            case 'yy':   return yy;
            case 'mm':   return mm;
            case 'dd':   return dd;
        }
        return tok;
    });
}


//Custom color picker.
//
//Why custom: <input type="color"> opens a native popover, which iOS
//Safari crashes on when invoked from a deeply nested Shadow DOM —
//exactly HA's setup (dashboard editor → custom card editor → Lit
//root). We replace it with an in-shadow swatch + popover exposing a
//curated 42-colour palette plus a hex text input for free entry.
@customElement('helios-color-picker')
export class HeliosColorPicker extends LitElement
{
    @property({ type: String }) public value:    string  = '#888888';
    @property({ type: String }) public ariaLabel: string = 'Color';
    @state()                    private _open    = false;
    @state()                    private _hexDraft = '';

    private static readonly PRESETS: string[] = [
        '#ffffff', '#f5f5f4', '#d4d4d8', '#a8a29e', '#52525b', '#1f2937', '#000000',
        '#fef3c7', '#fcd34d', '#f59e0b', '#ea580c', '#dc2626', '#991b1b', '#7c2d12',
        '#dcfce7', '#86efac', '#22c55e', '#16a34a', '#15803d', '#064e3b', '#052e16',
        '#dbeafe', '#93c5fd', '#3b82f6', '#2563eb', '#1d4ed8', '#1e3a8a', '#172554',
        '#ede9fe', '#c4b5fd', '#8b5cf6', '#7c3aed', '#6d28d9', '#4c1d95', '#2e1065',
        '#fce7f3', '#f9a8d4', '#ec4899', '#db2777', '#be185d', '#9d174d', '#500724'
    ];

    //Capturing document handler so a click outside closes the popover.
    private _onDocClick = (e: MouseEvent) =>
    {
        const path = e.composedPath();
        if (!path.includes(this))
        {
            this._open = false;
            document.removeEventListener('click', this._onDocClick, true);
        }
    };

    public disconnectedCallback(): void
    {
        super.disconnectedCallback();
        document.removeEventListener('click', this._onDocClick, true);
    }

    private _toggle(e: Event): void
    {
        e.stopPropagation();
        this._open = !this._open;
        this._hexDraft = this.value;
        if (this._open)
        {
            //Defer one tick so the click that opened the popover
            //doesn't immediately close it.
            setTimeout(() => document.addEventListener('click', this._onDocClick, true), 0);
        }
        else
        {
            document.removeEventListener('click', this._onDocClick, true);
        }
    }

    private _emit(value: string): void
    {
        this.value = value;
        this.dispatchEvent(new CustomEvent('value-changed',
            { detail: { value }, bubbles: true, composed: true }));
    }

    private _selectPreset(hex: string, e: Event): void
    {
        e.stopPropagation();
        this._emit(hex);
        this._open = false;
        document.removeEventListener('click', this._onDocClick, true);
    }

    private _onHexInput(e: Event): void
    {
        this._hexDraft = (e.target as HTMLInputElement).value;
    }

    private _commitHex(): void
    {
        const v = this._hexDraft.trim();
        const m = /^#?([0-9a-fA-F]{6})$/.exec(v);
        if (m)
        {
            this._emit('#' + m[1].toLowerCase());
        }
    }

    private _onHexKey(e: KeyboardEvent): void
    {
        if (e.key === 'Enter')
        {
            this._commitHex();
            this._open = false;
            document.removeEventListener('click', this._onDocClick, true);
        }
        else if (e.key === 'Escape')
        {
            this._open = false;
            document.removeEventListener('click', this._onDocClick, true);
        }
    }

    protected render(): TemplateResult
    {
        return html`
            <button
                type="button"
                class="swatch"
                style="background:${this.value}"
                aria-label="${this.ariaLabel}"
                aria-haspopup="dialog"
                aria-expanded="${this._open}"
                @click="${this._toggle}"
            ></button>
            ${this._open ? html`
                <div class="pop" role="dialog" @click="${(e: Event) => e.stopPropagation()}">
                    <div class="grid">
                        ${HeliosColorPicker.PRESETS.map(c => html`
                            <button
                                type="button"
                                class="cell ${c.toLowerCase() === this.value.toLowerCase() ? 'selected' : ''}"
                                style="background:${c}"
                                aria-label="${c}"
                                @click="${(e: Event) => this._selectPreset(c, e)}"
                            ></button>
                        `)}
                    </div>
                    <div class="hex-row">
                        <span class="hex-prefix">#</span>
                        <input
                            class="hex-input"
                            type="text"
                            spellcheck="false"
                            autocomplete="off"
                            maxlength="7"
                            .value="${this._hexDraft.replace(/^#/, '')}"
                            @input="${this._onHexInput}"
                            @blur="${this._commitHex}"
                            @keydown="${this._onHexKey}"
                        />
                    </div>
                </div>
            ` : nothing}
        `;
    }

    static styles = css`
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
}


//Visual editor — exposes every config option through native HA form
//controls (text inputs, color picker, entity picker). Wired into the
//card via HeliosCard.getConfigElement().
@customElement('helios-card-editor')
export class HeliosCardEditor extends LitElement
{
    @property({ attribute: false }) public hass?: any;
    @state()                        private _cfg: HeliosConfig = { 'maptiler-api-key': '' };
    @state()                        private _pickerReady = false;

    //Per-key debounce timers for slider inputs. Sliders fire @input
    //on every pixel of drag, which used to cascade an updateConfig +
    //full re-render through the engine on each tick — visibly painful
    //during preview. We update the local _cfg synchronously (so the
    //slider's bound .value tracks the drag perfectly) but only
    //dispatch the cross-component `config-changed` event after a
    //short idle window.
    private static readonly SLIDER_COMMIT_DELAY_MS = 250;
    private _sliderDebounce: Map<string, number> = new Map();

    public disconnectedCallback(): void
    {
        super.disconnectedCallback();
        for (const t of this._sliderDebounce.values()) window.clearTimeout(t);
        this._sliderDebounce.clear();
    }

    public setConfig(config: HeliosConfig): void
    {
        this._cfg = { ...config };
    }

    public connectedCallback(): void
    {
        super.connectedCallback();
        this._ensureEntityPicker();
    }

    //ha-entity-picker is part of HA's lazy-loaded card-editor bundle.
    //In a fresh tab, or in HA versions that don't pre-load it for
    //custom cards, the tag is unknown until something on the page
    //pulls it in. We force the load by creating a transient
    //"entities" card and asking for its config element — the side
    //effect registers ha-entity-picker. While the load is pending we
    //fall back to a plain text input so the field is never broken.
    private async _ensureEntityPicker(): Promise<void>
    {
        if (this._pickerReady) return;
        if (typeof customElements !== 'undefined' && customElements.get('ha-entity-picker'))
        {
            this._pickerReady = true;
            return;
        }

        try
        {
            const w: any = window as any;
            if (typeof w.loadCardHelpers === 'function')
            {
                const helpers = await w.loadCardHelpers();
                if (helpers?.createCardElement)
                {
                    const card: any = await helpers.createCardElement({
                        type:     'entities',
                        entities: []
                    });
                    const ctor: any = card?.constructor;
                    if (typeof ctor?.getConfigElement === 'function')
                    {
                        await ctor.getConfigElement();
                    }
                }
            }
            if (typeof customElements !== 'undefined')
            {
                await Promise.race([
                    customElements.whenDefined('ha-entity-picker'),
                    new Promise<void>(resolve => setTimeout(resolve, 8000))
                ]);
            }
        }
        catch (e)
        {
            console.warn('[HELIOS] Failed to lazy-load ha-entity-picker:', e);
        }
        finally
        {
            this._pickerReady = true;
        }
    }

    private _t(): Translations
    {
        return pickTranslations(this.hass?.language);
    }

    private _update(key: keyof HeliosConfig, value: unknown): void
    {
        const next = { ...this._cfg, [key]: value };
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: next } }));
        this._cfg = next;
    }

    private _str(key: keyof HeliosConfig, e: Event): void
    {
        this._update(key, (e.target as HTMLInputElement).value);
    }

    //Slider commit. Updates local state synchronously so the slider
    //thumb tracks the drag, but defers the cross-component
    //`config-changed` event by SLIDER_COMMIT_DELAY_MS so the engine
    //doesn't see a flood of intermediate values.
    private _numSlider(key: keyof HeliosConfig, e: Event): void
    {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!isFinite(v)) return;

        //Local update only — no event dispatch yet.
        this._cfg = { ...this._cfg, [key]: v };

        const k        = String(key);
        const existing = this._sliderDebounce.get(k);
        if (existing !== undefined) window.clearTimeout(existing);
        const t = window.setTimeout(() =>
        {
            this._sliderDebounce.delete(k);
            this.dispatchEvent(new CustomEvent('config-changed',
                { detail: { config: this._cfg } }));
        }, HeliosCardEditor.SLIDER_COMMIT_DELAY_MS);
        this._sliderDebounce.set(k, t);
    }

    private _bool(key: keyof HeliosConfig, value: boolean): void
    {
        this._update(key, value);
    }

    private _color(key: keyof HeliosConfig, e: CustomEvent): void
    {
        this._update(key, e.detail.value);
    }

    //Format a numeric slider value for display alongside the input.
    //Integers stay integer; fractional values get 2 decimals.
    private _fmtNum(v: number, step: number): string
    {
        return step >= 1 ? String(Math.round(v)) : v.toFixed(2);
    }

    //Filter for the PV entity picker — accepts power/energy device
    //classes (the canonical case) plus any sensor whose unit looks
    //like W/kW/MW or Wh/kWh/MWh. The unit fallback covers custom
    //template sensors that don't bother declaring a device_class.
    private _pvEntityFilter = (entity: any): boolean =>
    {
        if (!entity || !entity.attributes) return false;
        const dc = entity.attributes.device_class;
        if (dc === 'power' || dc === 'energy') return true;
        const u = String(entity.attributes.unit_of_measurement ?? '').trim();
        return u === 'W'  || u === 'kW' || u === 'MW'
            || u === 'Wh' || u === 'kWh' || u === 'MWh';
    };

    //Filter for the battery SoC picker — sensors with device_class
    //'battery' (the canonical case used by every BMS integration)
    //or any sensor with a percent unit. Energy/power sensors are
    //intentionally excluded; SoC is a percentage by design.
    private _batterySocEntityFilter = (entity: any): boolean =>
    {
        if (!entity || !entity.attributes) return false;
        if (entity.attributes.device_class === 'battery') return true;
        const u = String(entity.attributes.unit_of_measurement ?? '').trim();
        return u === '%';
    };

    //Filter for the battery power picker — power-only (no energy).
    //The chip needs an instantaneous reading; cumulative kWh totals
    //wouldn't make sense here without on-the-fly differentiation,
    //which we deliberately don't do for battery (PV does, battery
    //doesn't, to keep this overlay simple per the design brief).
    private _batteryPowerEntityFilter = (entity: any): boolean =>
    {
        if (!entity || !entity.attributes) return false;
        if (entity.attributes.device_class === 'power') return true;
        const u = String(entity.attributes.unit_of_measurement ?? '').trim();
        return u === 'W' || u === 'kW' || u === 'MW';
    };

    protected render(): TemplateResult
    {
        const c = this._cfg;
        const t = this._t();

        return html`
            <div class="editor">

                <div class="section-title">${t.editor.required}</div>
                <label class="field">
                    <span class="label">${t.editor.apiKey}</span>
                    <input
                        type="text"
                        .value="${c['maptiler-api-key'] ?? ''}"
                        placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
                        @change="${(e: Event) => this._str('maptiler-api-key', e)}"
                    />
                </label>
                <div class="field-help">
                    ${t.editor.getKeyAt}
                    <a href="https://www.maptiler.com/cloud/" target="_blank" rel="noreferrer">maptiler.com</a>
                </div>
                <div class="hint">${t.editor.apiKeyHelp}</div>

                <div class="section-title">${t.editor.terrainRelief}</div>
                <label class="field">
                    <span class="label">${t.editor.hillshadeColor}</span>
                    <helios-color-picker
                        .value="${cfgHex(c['topography-color'], '#5064a0')}"
                        .ariaLabel="${t.editor.hillshadeColor}"
                        @value-changed="${(e: CustomEvent) => this._color('topography-color', e)}"
                    ></helios-color-picker>
                </label>
                <label class="field">
                    <span class="label">${t.editor.hillshadeStrength}</span>
                    <div class="slider-row">
                        <input
                            type="range" min="0" max="1" step="0.01"
                            .value="${String(c['topography-alpha'] ?? 0.65)}"
                            @input="${(e: Event) => this._numSlider('topography-alpha', e)}"
                        />
                        <span class="slider-value">${this._fmtNum(Number(c['topography-alpha'] ?? 0.65), 0.01)}</span>
                    </div>
                </label>
                <div class="hint">${t.editor.terrainReliefHint}</div>

                <div class="section-title">${t.editor.mapSection}</div>
                <div class="field">
                    <span class="label">${t.editor.mapStyle}</span>
                    <div class="segmented-toggle segmented-toggle-3">
                        <button
                            type="button"
                            class="seg-option ${(String(c['map-style'] ?? 'streets')) === 'streets' ? 'active' : ''}"
                            @click="${() => this._update('map-style', 'streets')}"
                        >${t.editor.mapStyleStreet}</button>
                        <button
                            type="button"
                            class="seg-option ${(String(c['map-style'] ?? 'streets')) === 'topo' ? 'active' : ''}"
                            @click="${() => this._update('map-style', 'topo')}"
                        >${t.editor.mapStyleTopo}</button>
                        <button
                            type="button"
                            class="seg-option ${(String(c['map-style'] ?? 'streets')) === 'minimal' ? 'active' : ''}"
                            @click="${() => this._update('map-style', 'minimal')}"
                        >${t.editor.mapStyleMinimal}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.mapStyleHint}</div>
                <div class="field">
                    <span class="label">${t.editor.terrainDetail}</span>
                    <div class="segmented-toggle">
                        <button
                            type="button"
                            class="seg-option ${(String(c['terrain-detail'] ?? 'smooth')) === 'smooth' ? 'active' : ''}"
                            @click="${() => this._update('terrain-detail', 'smooth')}"
                        >${t.editor.terrainDetailSmooth}</button>
                        <button
                            type="button"
                            class="seg-option ${(String(c['terrain-detail'] ?? 'smooth')) === 'fine' ? 'active' : ''}"
                            @click="${() => this._update('terrain-detail', 'fine')}"
                        >${t.editor.terrainDetailFine}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.terrainDetailHint}</div>
                <div class="field">
                    <span class="label">${t.editor.cardTheme}</span>
                    <div class="segmented-toggle">
                        <button
                            type="button"
                            class="seg-option ${(String(c['card-theme'] ?? 'light')) === 'light' ? 'active' : ''}"
                            @click="${() => this._update('card-theme', 'light')}"
                        >${t.editor.cardThemeLight}</button>
                        <button
                            type="button"
                            class="seg-option ${(String(c['card-theme'] ?? 'light')) === 'dark' ? 'active' : ''}"
                            @click="${() => this._update('card-theme', 'dark')}"
                        >${t.editor.cardThemeDark}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.cardThemeHint}</div>
                <div class="field">
                    <span class="label">${t.editor.showLabels}</span>
                    <div class="segmented-toggle">
                        <button
                            type="button"
                            class="seg-option ${(c['show-labels'] !== false) ? 'active' : ''}"
                            @click="${() => this._update('show-labels', true)}"
                        >${t.editor.labelsOn}</button>
                        <button
                            type="button"
                            class="seg-option ${(c['show-labels'] === false) ? 'active' : ''}"
                            @click="${() => this._update('show-labels', false)}"
                        >${t.editor.labelsOff}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.showLabelsHint}</div>
                <div class="field">
                    <span class="label">${t.editor.autoRotate}</span>
                    <div class="segmented-toggle">
                        <button
                            type="button"
                            class="seg-option ${(c['auto-rotate-enabled'] !== false) ? 'active' : ''}"
                            @click="${() => this._update('auto-rotate-enabled', true)}"
                        >${t.editor.autoRotateOn}</button>
                        <button
                            type="button"
                            class="seg-option ${(c['auto-rotate-enabled'] === false) ? 'active' : ''}"
                            @click="${() => this._update('auto-rotate-enabled', false)}"
                        >${t.editor.autoRotateOff}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.autoRotateHint}</div>
                <div class="field">
                    <span class="label">${t.editor.performanceMode}</span>
                    <div class="segmented-toggle">
                        <button
                            type="button"
                            class="seg-option ${(c['performance-mode'] !== true) ? 'active' : ''}"
                            @click="${() => this._bool('performance-mode', false)}"
                        >${t.editor.performanceModeOff}</button>
                        <button
                            type="button"
                            class="seg-option ${(c['performance-mode'] === true) ? 'active' : ''}"
                            @click="${() => this._bool('performance-mode', true)}"
                        >${t.editor.performanceModeOn}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.performanceModeHint}</div>

                <div class="section-title">${t.editor.buildingsSection}</div>
                <label class="field">
                    <span class="label">${t.editor.buildingRadius}</span>
                    <div class="slider-row">
                        <input
                            type="range" min="20" max="1000" step="10"
                            .value="${String(c['building-radius'] ?? DEFAULT_BUILDING_RADIUS_M)}"
                            @input="${(e: Event) => this._numSlider('building-radius', e)}"
                        />
                        <span class="slider-value">${this._fmtNum(Number(c['building-radius'] ?? DEFAULT_BUILDING_RADIUS_M), 1)} m</span>
                    </div>
                </label>
                <label class="field">
                    <span class="label">${t.editor.buildingClusterRadius}</span>
                    <div class="slider-row">
                        <input
                            type="range" min="0" max="100" step="1"
                            .value="${String(c['building-cluster-radius'] ?? DEFAULT_BUILDING_CLUSTER_RADIUS_M)}"
                            @input="${(e: Event) => this._numSlider('building-cluster-radius', e)}"
                        />
                        <span class="slider-value">${this._fmtNum(Number(c['building-cluster-radius'] ?? DEFAULT_BUILDING_CLUSTER_RADIUS_M), 1)} m</span>
                    </div>
                </label>
                <label class="field">
                    <span class="label">${t.editor.buildingOpacity}</span>
                    <div class="slider-row">
                        <input
                            type="range" min="0" max="1" step="0.05"
                            .value="${String(c['building-opacity'] ?? DEFAULT_BUILDING_OPACITY)}"
                            @input="${(e: Event) => this._numSlider('building-opacity', e)}"
                        />
                        <span class="slider-value">${this._fmtNum(Number(c['building-opacity'] ?? DEFAULT_BUILDING_OPACITY), 0.05)}</span>
                    </div>
                </label>
                <label class="field">
                    <span class="label">${t.editor.buildingColor}</span>
                    <helios-color-picker
                        .value="${cfgHex(c['building-color'], DEFAULT_BUILDING_COLOR_HEX)}"
                        .ariaLabel="${t.editor.buildingColor}"
                        @value-changed="${(e: CustomEvent) => this._color('building-color', e)}"
                    ></helios-color-picker>
                </label>
                <div class="hint">${t.editor.buildingsHint}</div>

                <div class="section-title">${t.editor.colors}</div>
                <label class="field">
                    <span class="label">${t.editor.sunColor}</span>
                    <helios-color-picker
                        .value="${cfgHex(c['sun-color'], DEFAULT_SUN_COLOR_HEX)}"
                        .ariaLabel="${t.editor.sunColor}"
                        @value-changed="${(e: CustomEvent) => this._color('sun-color', e)}"
                    ></helios-color-picker>
                </label>
                <label class="field">
                    <span class="label">${t.editor.cloudColor}</span>
                    <helios-color-picker
                        .value="${cfgHex(c['cloud-color'], DEFAULT_CLOUD_COLOR_HEX)}"
                        .ariaLabel="${t.editor.cloudColor}"
                        @value-changed="${(e: CustomEvent) => this._color('cloud-color', e)}"
                    ></helios-color-picker>
                </label>
                <div class="hint">${t.editor.colorsHint}</div>

                <div class="section-title">${t.editor.pvSection}</div>
                <div class="field field-block">
                    <span class="label">${t.editor.pvEntity}</span>
                    ${this._pickerReady ? html`
                        <ha-entity-picker
                            allow-custom-entity
                            .hass="${this.hass}"
                            .value="${String(c['pv-power-entity'] ?? '')}"
                            .includeDomains="${['sensor', 'input_number']}"
                            .entityFilter="${this._pvEntityFilter}"
                            @value-changed="${(e: CustomEvent) => this._update('pv-power-entity', e.detail.value ?? '')}"
                        ></ha-entity-picker>
                    ` : html`
                        <input
                            type="text"
                            .value="${String(c['pv-power-entity'] ?? '')}"
                            placeholder="sensor.solar_power"
                            @change="${(e: Event) => this._str('pv-power-entity', e)}"
                        />
                    `}
                </div>
                <div class="field-help">${t.editor.pvEntityHelp}</div>
                <label class="field">
                    <span class="label">${t.editor.pvColor}</span>
                    <helios-color-picker
                        .value="${cfgHex(c['pv-color'], DEFAULT_PV_COLOR_HEX)}"
                        .ariaLabel="${t.editor.pvColor}"
                        @value-changed="${(e: CustomEvent) => this._color('pv-color', e)}"
                    ></helios-color-picker>
                </label>
                <div class="hint">${t.editor.pvHint}</div>

                <div class="section-title">${t.editor.batterySection}</div>
                <div class="field field-block">
                    <span class="label">${t.editor.batterySocEntity}</span>
                    ${this._pickerReady ? html`
                        <ha-entity-picker
                            allow-custom-entity
                            .hass="${this.hass}"
                            .value="${String(c['battery-soc-entity'] ?? '')}"
                            .includeDomains="${['sensor', 'input_number']}"
                            .entityFilter="${this._batterySocEntityFilter}"
                            @value-changed="${(e: CustomEvent) => this._update('battery-soc-entity', e.detail.value ?? '')}"
                        ></ha-entity-picker>
                    ` : html`
                        <input
                            type="text"
                            .value="${String(c['battery-soc-entity'] ?? '')}"
                            placeholder="sensor.battery_soc"
                            @change="${(e: Event) => this._str('battery-soc-entity', e)}"
                        />
                    `}
                </div>
                <div class="field-help">${t.editor.batterySocEntityHelp}</div>
                <div class="field field-block">
                    <span class="label">${t.editor.batteryPowerEntity}</span>
                    ${this._pickerReady ? html`
                        <ha-entity-picker
                            allow-custom-entity
                            .hass="${this.hass}"
                            .value="${String(c['battery-power-entity'] ?? '')}"
                            .includeDomains="${['sensor', 'input_number']}"
                            .entityFilter="${this._batteryPowerEntityFilter}"
                            @value-changed="${(e: CustomEvent) => this._update('battery-power-entity', e.detail.value ?? '')}"
                        ></ha-entity-picker>
                    ` : html`
                        <input
                            type="text"
                            .value="${String(c['battery-power-entity'] ?? '')}"
                            placeholder="sensor.battery_power"
                            @change="${(e: Event) => this._str('battery-power-entity', e)}"
                        />
                    `}
                </div>
                <div class="field-help">${t.editor.batteryPowerEntityHelp}</div>
                <label class="field">
                    <span class="label">${t.editor.batteryColor}</span>
                    <helios-color-picker
                        .value="${cfgHex(c['battery-color'], DEFAULT_BATTERY_COLOR_HEX)}"
                        .ariaLabel="${t.editor.batteryColor}"
                        @value-changed="${(e: CustomEvent) => this._color('battery-color', e)}"
                    ></helios-color-picker>
                </label>
                <div class="hint">${t.editor.batteryHint}</div>

                <div class="section-title">${t.editor.timeline}</div>
                <label class="field">
                    <span class="label">${t.editor.dateFormat}</span>
                    <input
                        type="text"
                        .value="${String(c['date-format'] ?? '')}"
                        placeholder="mm-dd"
                        @change="${(e: Event) => this._str('date-format', e)}"
                    />
                </label>
                <div class="field-help">
                    ${t.editor.dateFormatHelp} <code>mm-dd</code>, <code>dd/mm</code>, <code>yyyy-mm-dd</code>.
                </div>
                <div class="field">
                    <span class="label">${t.editor.timeFormat}</span>
                    <div class="segmented-toggle">
                        <button
                            type="button"
                            class="seg-option ${(String(c['time-format'] ?? '24h')) === '24h' ? 'active' : ''}"
                            @click="${() => this._update('time-format', '24h')}"
                        >${t.editor.timeFormat24}</button>
                        <button
                            type="button"
                            class="seg-option ${(String(c['time-format'] ?? '24h')) === '12h' ? 'active' : ''}"
                            @click="${() => this._update('time-format', '12h')}"
                        >${t.editor.timeFormat12}</button>
                    </div>
                </div>
                <div class="hint">${t.editor.timelineHint}</div>

            </div>
        `;
    }

    static styles = css`
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

        .field-help
        {
            font-size: 11px;
            color: var(--secondary-text-color, #727272);
            margin-top: -6px;
            margin-bottom: 4px;
        }

        .field-help a       { color: var(--primary-color, #03a9f4); text-decoration: none; }
        .field-help a:hover { text-decoration: underline; }

        .hint
        {
            font-size: 11px;
            color: var(--secondary-text-color, #727272);
            font-style: italic;
        }

        .field
        {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            position: relative;
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

        /*  Slider variant — replaces type="number" inputs so the
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
    `;
}
