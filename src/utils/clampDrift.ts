import { GLib, Meta } from '../gi/ext';
import Settings from '../settings/settings';
import ExtendedWindow from '../components/tilingsystem/extendedWindow';
import {
    adoptExternalTarget,
    copyGeomRect,
    geomDelta,
    getGeomTarget,
    isClampGivenUp,
    isGeomSuppressed,
    setClampGivenUp,
    suppressOwnResize,
    snapHistory,
    type GeomRect,
} from './geomState';

const PREFIX = '[TS-GEOM]';

/** Small unsolicited changes at or under this size are pulled back. */
const DRIFT_THRESHOLD_PX = 32;

/**
 * Snap-backs closer together than this belong to one feedback burst.
 * Three of those in a row means the client is fighting the clamp.
 */
const BURST_WINDOW_US = 100_000;
const BURST_LIMIT = 3;

/**
 * Hard stop for a runaway slower than one burst. High enough that a manual
 * focus test of about ten cycles still clamps, low enough that a steady
 * fight stops within two seconds.
 */
const RATE_WINDOW_US = 2_000_000;
const RATE_LIMIT = 16;

function clampEnabled(): boolean {
    try {
        return Settings.CLAMP_TILED_DRIFT;
    } catch (_e) {
        return false;
    }
}

function debugOn(): boolean {
    try {
        return Settings.DEBUG_GEOMETRY_LOG;
    } catch (_e) {
        return false;
    }
}

function isTiled(window: Meta.Window): boolean {
    return (window as ExtendedWindow).assignedTile !== undefined;
}

function isMovingGrab(grabOp: number): boolean {
    const op = grabOp & ~1024;

    return (
        op === Meta.GrabOp.MOVING ||
        op === Meta.GrabOp.MOVING_UNCONSTRAINED ||
        op === Meta.GrabOp.KEYBOARD_MOVING
    );
}

function rectOf(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
}): GeomRect {
    return copyGeomRect(rect);
}

function rectString(rect: GeomRect | null | undefined): string {
    if (!rect) return 'none';

    return `{x:${rect.x},y:${rect.y},w:${rect.width},h:${rect.height}}`;
}

function deltaString(delta: {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
}): string {
    return `{dx:${delta.dx},dy:${delta.dy},dw:${delta.dw},dh:${delta.dh}}`;
}

function isZeroDelta(delta: {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
}): boolean {
    return [delta.dx, delta.dy, delta.dw, delta.dh].every(
        value => Math.abs(value) < 0.5
    );
}

function withinThreshold(delta: {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
}): boolean {
    return [delta.dx, delta.dy, delta.dw, delta.dh].every(
        value => Math.abs(value) <= DRIFT_THRESHOLD_PX
    );
}

function windowLabel(window: Meta.Window): string {
    let title = '';
    let wmClass = '';
    try {
        title = (window.get_title() ?? '').replace(/\s+/g, ' ');
    } catch (_e) {
        title = '';
    }
    try {
        wmClass = window.get_wm_class() ?? '';
    } catch (_e) {
        wmClass = '';
    }

    return `title=${JSON.stringify(title)} wm_class=${JSON.stringify(wmClass)}`;
}

function blocked(window: Meta.Window): boolean {
    if (window.minimized) return true;
    if (window.maximizedHorizontally || window.maximizedVertically) return true;
    try {
        if (window.is_fullscreen()) return true;
    } catch (_e) {
        return false;
    }
    if (typeof window.allows_resize === 'function' && !window.allows_resize())
        return true;

    return false;
}

/**
 * Record a snap-back. `burst` or `rate` means the loop guard tripped and the
 * caller must leave the window alone until Tiling Shell places it again.
 */
function allowSnap(
    window: Meta.Window,
    nowUs: number
): 'ok' | 'burst' | 'rate' {
    const history = snapHistory(window);
    const recent = history.snapTimes.filter(
        stamp => nowUs - stamp < RATE_WINDOW_US
    );
    const inBurst =
        history.lastSnapAt > 0 && nowUs - history.lastSnapAt <= BURST_WINDOW_US;
    const burst = inBurst ? history.snapBurst + 1 : 1;
    history.lastSnapAt = nowUs;
    history.snapBurst = burst;
    history.snapTimes = recent;

    if (burst > BURST_LIMIT) return 'burst';
    if (recent.length >= RATE_LIMIT) return 'rate';

    recent.push(nowUs);

    return 'ok';
}

class ClampDrift {
    private _createdId = 0;

    private _grabBeginId = 0;

    private _grabEndId = 0;

    private readonly _windows = new Map<Meta.Window, number[]>();

    private readonly _grabs = new Set<Meta.Window>();

    private readonly _pending = new Map<Meta.Window, number>();

    enable(): void {
        this._createdId = global.display.connect(
            'window-created',
            (_display: Meta.Display, window: Meta.Window) => {
                this._track(window);
            }
        );
        this._grabBeginId = global.display.connect(
            'grab-op-begin',
            (_display: Meta.Display, window: Meta.Window | null) => {
                if (window) this._grabs.add(window);
            }
        );
        this._grabEndId = global.display.connect(
            'grab-op-end',
            (
                _display: Meta.Display,
                window: Meta.Window | null,
                grabOp: Meta.GrabOp
            ) => {
                if (!window) return;
                this._grabs.delete(window);
                this._adoptResize(window, grabOp);
            }
        );
        global.get_window_actors().forEach(actor => {
            if (actor.metaWindow) this._track(actor.metaWindow);
        });
    }

    disable(): void {
        if (this._createdId > 0) {
            global.display.disconnect(this._createdId);
            this._createdId = 0;
        }
        if (this._grabBeginId > 0) {
            global.display.disconnect(this._grabBeginId);
            this._grabBeginId = 0;
        }
        if (this._grabEndId > 0) {
            global.display.disconnect(this._grabEndId);
            this._grabEndId = 0;
        }
        Array.from(this._pending.entries()).forEach(([window, sourceId]) => {
            this._pending.delete(window);
            GLib.Source.remove(sourceId);
        });
        Array.from(this._windows.keys()).forEach(window =>
            this._untrack(window)
        );
        this._grabs.clear();
    }

    private _track(window: Meta.Window): void {
        if (this._windows.has(window)) return;

        const ids = [
            window.connect('size-changed', () => {
                this._onGeometry(window);
            }),
            window.connect('position-changed', () => {
                this._onGeometry(window);
            }),
            window.connect('unmanaged', () => {
                this._untrack(window);
            }),
        ];
        this._windows.set(window, ids);
    }

    private _untrack(window: Meta.Window): void {
        const ids = this._windows.get(window);
        this._windows.delete(window);
        this._grabs.delete(window);
        const pending = this._pending.get(window);
        if (pending !== undefined) {
            this._pending.delete(window);
            GLib.Source.remove(pending);
        }
        ids?.forEach(id => {
            try {
                window.disconnect(id);
            } catch (_e) {
                // The window may already be unmanaged.
            }
        });
    }

    private _onGeometry(window: Meta.Window): void {
        try {
            if (!this._shouldConsider(window)) return;
            if (this._pending.has(window)) return;

            const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._pending.delete(window);
                this._clampOnIdle(window);

                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(window, sourceId);
        } catch (_e) {
            // Clamping must not affect the rest of the shell.
        }
    }

    private _shouldConsider(window: Meta.Window): boolean {
        if (!clampEnabled()) return false;
        if (!this._windows.has(window)) return false;
        if (isGeomSuppressed(window)) return false;
        if (this._grabs.has(window)) return false;
        if (isClampGivenUp(window)) return false;
        if (!isTiled(window)) return false;
        if (blocked(window)) return false;

        return true;
    }

    private _adoptResize(window: Meta.Window, grabOp: Meta.GrabOp): void {
        try {
            if (!clampEnabled()) return;
            if (isMovingGrab(grabOp)) return;
            if (!isTiled(window) || blocked(window)) return;
            if (isClampGivenUp(window)) return;

            const frame = rectOf(window.get_frame_rect());
            const target = getGeomTarget(window);
            if (!target) return;

            const delta = geomDelta(frame, target);
            if (isZeroDelta(delta)) return;

            adoptExternalTarget(window, frame);
            if (!debugOn()) return;

            console.log(
                PREFIX,
                'action=clamp-retarget',
                windowLabel(window),
                `before=${rectString(target)}`,
                `after=${rectString(frame)}`,
                `delta=${deltaString(delta)}`
            );
        } catch (_e) {
            // A finished resize should still complete if bookkeeping fails.
        }
    }

    private _clampOnIdle(window: Meta.Window): void {
        try {
            if (!this._shouldConsider(window)) return;

            const target = getGeomTarget(window);
            if (!target) return;

            const before = rectOf(window.get_frame_rect());
            const delta = geomDelta(before, target);
            if (isZeroDelta(delta)) return;

            if (!withinThreshold(delta)) {
                adoptExternalTarget(window, before);
                if (!debugOn()) return;

                console.log(
                    PREFIX,
                    'action=clamp-retarget',
                    windowLabel(window),
                    `before=${rectString(target)}`,
                    `after=${rectString(before)}`,
                    `delta=${deltaString(delta)}`
                );

                return;
            }

            const nowUs = GLib.get_monotonic_time();
            const verdict = allowSnap(window, nowUs);
            if (verdict !== 'ok') {
                setClampGivenUp(window, true);
                console.log(
                    PREFIX,
                    'action=clamp-giveup',
                    windowLabel(window),
                    `reason=${verdict}`,
                    `before=${rectString(before)}`,
                    `target=${rectString(target)}`,
                    `delta=${deltaString(delta)}`
                );

                return;
            }

            const x = Math.round(target.x);
            const y = Math.round(target.y);
            const width = Math.round(target.width);
            const height = Math.round(target.height);
            suppressOwnResize(window);
            // user_op is true so the client receives this as the size to keep.
            window.move_resize_frame(true, x, y, width, height);
            const after = rectOf(window.get_frame_rect());
            if (!debugOn()) return;

            console.log(
                PREFIX,
                'action=clamp-drift',
                windowLabel(window),
                `before=${rectString(before)}`,
                `after=${rectString(after)}`,
                `target=${rectString(target)}`,
                `delta=${deltaString(delta)}`
            );
        } catch (_e) {
            // Clamping must not affect the rest of the shell.
        }
    }
}

let controller: ClampDrift | null = null;

export function enableClampDrift(): void {
    disableClampDrift();
    controller = new ClampDrift();
    controller.enable();
}

export function disableClampDrift(): void {
    controller?.disable();
    controller = null;
}
