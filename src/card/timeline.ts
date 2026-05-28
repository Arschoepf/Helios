//Timeline subsystem: the periodic clock tick that advances the live cursor and re-projects the screen-space overlays, the pointer handlers that scrub
//the timeline into the past, plus the three small config readers that drive the timeline's visibility, width, and per-day consumption chip.
//
//Same host-driven pattern as the data modules: the card owns the `@state` timeline fields, the functions here read / write them through a structural
//TimelineHost interface and Lit's reactivity falls out naturally on every assignment.

import type { HeliosConfig } from '../helios-config';
import
{
    DEFAULT_TIMELINE_ENABLED,
    DEFAULT_TIMELINE_WIDTH_PCT,
    DEFAULT_TIMELINE_CONSUMPTION_ENABLED
} from '../helios-config';
import { refreshOverlays, type OverlaysHost } from './overlays';
import type { HeliosEngine } from '../helios-engine';


//Structural surface the host card exposes to this module. Extends
//OverlaysHost so the clock tick can fire refreshOverlays(host) on
//the same value without juggling two parameters.
export interface TimelineHost extends OverlaysHost
{
    readonly config:    HeliosConfig | undefined;
    readonly _engine?:  HeliosEngine;

    _timeRange:         { start: Date; end: Date } | null;
    _selectedTime:      Date | null;
    _isLiveMode:        boolean;
    _now:               Date;

    //Hover cursor position on the timeline charts. The scrub handler
    //below writes it in lock-step with _selectedTime so the hover
    //tooltip + per-curve dots follow a touch drag on mobile (the
    //chart-card pointer handlers don't fire once the time-bar
    //captures the pointer; updating from here gives mobile users the
    //same readout desktop users get on hover).
    _chartHoverPct:     number | null;

    _trackElement:      HTMLElement | null;
    _trackPointerId:    number | null;
    _boundPointerMove:  (e: PointerEvent) => void;
    _boundPointerUp:    (e: PointerEvent) => void;
}


//Re-renders the card every 30 seconds.
//  - In live mode this advances both the HH:MM clock display
//    (seconds were dropped to allow the slower cadence) and the
//    live cursor on the timeline.
//  - In scrubbed mode the clock shows the selected instant and the
//    live cursor still continues to move underneath as wall-clock
//    time progresses.
//PV and battery live readings update on Home Assistant state
//changes, not on this tick, so they stay real-time regardless.
export function tick(host: TimelineHost): void
{
    host._now = new Date();
    //The sun moves with time, so refresh its screen-space
    //position too. The other parts of refreshOverlays
    //(percentage label) are camera-driven and won't change
    //here, but recomputing them is cheap and keeps the code
    //path uniform.
    refreshOverlays(host);
}


//Start scrubbing on pointer-down. Captures the pointer so subsequent moves and the eventual up land on the same track element regardless of where the
//user drags. Swallowed during the engine's post-exit cooldown so the click that dismissed the dashboard panel can't bleed into an immediate scrub on
//the timeline behind it.
export function onTimelinePointerDown(host: TimelineHost, e: PointerEvent): void
{
    if (!host._timeRange)
    {
        return;
    }
    if (host._engine?.isUserGestureSuppressed())
    {
        return;
    }
    const track = e.currentTarget as HTMLElement;
    track.setPointerCapture(e.pointerId);
    host._trackElement   = track;
    host._trackPointerId = e.pointerId;
    track.addEventListener('pointermove',   host._boundPointerMove);
    track.addEventListener('pointerup',     host._boundPointerUp);
    track.addEventListener('pointercancel', host._boundPointerUp);
    applyTimelinePointer(host, e);
}


export function onTimelinePointerMove(host: TimelineHost, e: PointerEvent): void
{
    if (e.pointerId !== host._trackPointerId)
    {
        return;
    }
    applyTimelinePointer(host, e);
}


export function onTimelinePointerUp(host: TimelineHost, e: PointerEvent): void
{
    if (e.pointerId !== host._trackPointerId)
    {
        return;
    }
    const track = host._trackElement;
    if (track)
    {
        try
        {
            track.releasePointerCapture(e.pointerId);
        }
        catch (_) {}
        track.removeEventListener('pointermove',   host._boundPointerMove);
        track.removeEventListener('pointerup',     host._boundPointerUp);
        track.removeEventListener('pointercancel', host._boundPointerUp);
    }
    host._trackElement   = null;
    host._trackPointerId = null;
    //Drop the hover once the gesture ends so the tooltip + dots disappear cleanly on touch release. Desktop hover keeps using the chart-card pointer
    //handlers above this layer.
    host._chartHoverPct  = null;
}


//Translate the pointer's clientX into a timestamp inside the active
//time range and pin the card into scrubbed mode. No hour-snap on the
//selected time: the previous behaviour rounded to the nearest full
//hour, which made the sun arc and the cloud disc jerk forward in 1 h
//jumps as the user dragged the cursor. Sub-hour timestamps still
//resolve to the right hourly bucket for weather variables (which are
//only published hourly) via nearest-hour lookup in the engine, so we
//keep accuracy where it matters and animate the sun position smoothly
//where it doesn't.
export function applyTimelinePointer(host: TimelineHost, e: PointerEvent): void
{
    if (!host._timeRange)
    {
        return;
    }
    const track   = e.currentTarget as HTMLElement;
    const rect    = track.getBoundingClientRect();
    const frac    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const rangeMs = host._timeRange.end.getTime() - host._timeRange.start.getTime();
    const t = new Date(host._timeRange.start.getTime() + frac * rangeMs);

    if (host._selectedTime && host._selectedTime.getTime() === t.getTime())
    {
        return;
    }

    host._selectedTime  = t;
    host._isLiveMode    = false;
    host._chartHoverPct = frac * 100;
    host._engine?.setSelectedTime(t);
}


//Drop scrubbed mode and snap the card back to live. The engine's selected-time hook is cleared so the next render pulls the present moment instead of
//the cached scrub instant.
export function resetToLive(host: TimelineHost): void
{
    host._selectedTime = null;
    host._isLiveMode   = true;
    host._engine?.setSelectedTime(null);
}


//Read the timeline visibility toggle. Default true so a fresh card config keeps showing the chart.
export function timelineEnabled(config: HeliosConfig | undefined): boolean
{
    const raw = config?.['timeline-enabled'];
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string')
    {
        const s = raw.trim().toLowerCase();
        if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
        if (s === 'true'  || s === '1' || s === 'on'  || s === 'yes') return true;
    }
    return DEFAULT_TIMELINE_ENABLED;
}


//Read the timeline width as a percentage [50..100]. Clamped so a hand-edited YAML can't shrink the bar into uselessness or overflow the card edge.
export function timelineWidthPct(config: HeliosConfig | undefined): number
{
    const raw = config?.['timeline-width-pct'];
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    if (!isFinite(n)) return DEFAULT_TIMELINE_WIDTH_PCT;
    return Math.min(100, Math.max(50, n));
}


//Read the per-day consumption chip toggle. Default true so the existing kWh readouts stay visible on legacy configs.
export function timelineConsumptionEnabled(config: HeliosConfig | undefined): boolean
{
    const raw = config?.['timeline-consumption-enabled'];
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string')
    {
        const s = raw.trim().toLowerCase();
        if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
        if (s === 'true'  || s === '1' || s === 'on'  || s === 'yes') return true;
    }
    return DEFAULT_TIMELINE_CONSUMPTION_ENABLED;
}
