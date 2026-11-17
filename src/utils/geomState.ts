import { GLib, Meta } from '../gi/ext';

export interface GeomRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SnapHistory {
    lastSnapAt: number;
    snapBurst: number;
    snapTimes: number[];
}

interface GeomRecord {
    target?: GeomRect;
    suppressEpoch: number;
    giveup: boolean;
    snap: SnapHistory;
}

const records = new WeakMap<Meta.Window, GeomRecord>();

function record(window: Meta.Window): GeomRecord {
    let found = records.get(window);
    if (!found) {
        found = {
            suppressEpoch: 0,
            giveup: false,
            snap: { lastSnapAt: 0, snapBurst: 0, snapTimes: [] },
        };
        records.set(window, found);
    }

    return found;
}

export function copyGeomRect(rect: GeomRect): GeomRect {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

export function geomDelta(
    frame: GeomRect,
    target: GeomRect
): { dx: number; dy: number; dw: number; dh: number } {
    return {
        dx: frame.x - target.x,
        dy: frame.y - target.y,
        dw: frame.width - target.width,
        dh: frame.height - target.height,
    };
}

export function getGeomTarget(window: Meta.Window): GeomRect | undefined {
    const target = record(window).target;

    return target ? copyGeomRect(target) : undefined;
}

export function isGeomSuppressed(window: Meta.Window): boolean {
    return record(window).suppressEpoch > 0;
}

export function isClampGivenUp(window: Meta.Window): boolean {
    return record(window).giveup;
}

export function setClampGivenUp(window: Meta.Window, givenUp: boolean): void {
    record(window).giveup = givenUp;
}

export function snapHistory(window: Meta.Window): SnapHistory {
    return record(window).snap;
}

export function clearSnapHistory(window: Meta.Window): void {
    const snap = record(window).snap;
    snap.lastSnapAt = 0;
    snap.snapBurst = 0;
    snap.snapTimes = [];
}

/**
 * Remember a rectangle Tiling Shell itself requested. The size-changed that
 * follows is ignored until the next idle, and a previous give-up is cleared
 * because the window was placed again.
 */
export function rememberTilingTarget(
    window: Meta.Window,
    rect: GeomRect
): void {
    const state = record(window);
    state.target = copyGeomRect(rect);
    state.giveup = false;
    clearSnapHistory(window);
    armSuppress(window);
}

/** Keep a new external size as the baseline. Does not move the window. */
export function adoptExternalTarget(window: Meta.Window, rect: GeomRect): void {
    record(window).target = copyGeomRect(rect);
}

/** Ignore geometry signals caused by a snap-back until the next idle. */
export function suppressOwnResize(window: Meta.Window): void {
    armSuppress(window);
}

function armSuppress(window: Meta.Window): void {
    const state = record(window);
    const epoch = state.suppressEpoch + 1;
    state.suppressEpoch = epoch;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        const current = records.get(window);
        if (current && current.suppressEpoch === epoch)
            current.suppressEpoch = 0;

        return GLib.SOURCE_REMOVE;
    });
}
