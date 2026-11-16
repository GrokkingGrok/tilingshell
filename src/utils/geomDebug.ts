import { Gio, Meta } from '../gi/ext';
import Settings from '../settings/settings';
import ExtendedWindow from '../components/tilingsystem/extendedWindow';
import TileUtils from '../components/layout/TileUtils';

const PREFIX = '[TS-GEOM]';

type RectLike = {
    x: number;
    y: number;
    width: number;
    height: number;
};

interface GeomWindow extends Meta.Window {
    __ts_geom_target?: RectLike;
}

interface MaybeClientDecorated extends Meta.Window {
    is_client_decorated?: () => boolean;
}

let textScaleSettings: Gio.Settings | null = null;
let hasFocusProperty: boolean | null = null;

function debugOn(): boolean {
    try {
        return Settings.DEBUG_GEOMETRY_LOG;
    } catch (_e) {
        return false;
    }
}

function rectString(rect: RectLike | null | undefined): string {
    if (!rect) return 'none';

    return `{x:${rect.x},y:${rect.y},w:${rect.width},h:${rect.height}}`;
}

function deltaString(
    frame: RectLike,
    other: RectLike | null | undefined
): string {
    if (!other) return 'n/a';

    return `{dx:${frame.x - other.x},dy:${frame.y - other.y},dw:${frame.width - other.width},dh:${frame.height - other.height}}`;
}

function textScale(): number {
    try {
        if (!textScaleSettings) {
            textScaleSettings = new Gio.Settings({
                schema: 'org.gnome.desktop.interface',
            });
        }

        return textScaleSettings.get_double('text-scaling-factor');
    } catch (_e) {
        return -1;
    }
}

function clientTypeName(window: Meta.Window): string {
    try {
        const kind = window.get_client_type();
        if (kind === Meta.WindowClientType.WAYLAND) return 'wayland';
        if (kind === Meta.WindowClientType.X11) return 'x11';

        return String(kind);
    } catch (_e) {
        return 'unknown';
    }
}

function decorationInfo(window: Meta.Window): string {
    const parts = [`client_type=${clientTypeName(window)}`];
    try {
        parts.push(`decorated=${window.decorated}`);
    } catch (_e) {
        parts.push('decorated=unknown');
    }

    const decoratedWindow = window as MaybeClientDecorated;
    if (typeof decoratedWindow.is_client_decorated === 'function') {
        try {
            parts.push(
                `client_decorated=${decoratedWindow.is_client_decorated()}`
            );
        } catch (_e) {
            parts.push('client_decorated=error');
        }
    } else {
        parts.push('client_decorated=unavailable');
    }

    try {
        parts.push(
            `frame_type=${Meta.frame_type_to_string(window.get_frame_type())}`
        );
    } catch (_e) {
        // Frame type is extra context. Skip it when this shell lacks it.
    }

    return parts.join(' ');
}

function scaleInfo(window: Meta.Window): string {
    const monitor = window.get_monitor();
    let monitorScale = -1;
    try {
        if (monitor >= 0)
            monitorScale = global.display.get_monitor_scale(monitor);
    } catch (_e) {
        monitorScale = -1;
    }

    return `text_scale=${textScale()} monitor_scale=${monitorScale} monitor=${monitor}`;
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

function tilePixel(window: Meta.Window): RectLike | null {
    const tile = (window as ExtendedWindow).assignedTile;
    if (!tile) return null;

    try {
        const monitor = window.get_monitor();
        if (monitor < 0) return null;

        return TileUtils.apply_props(
            tile,
            window.get_work_area_for_monitor(monitor)
        );
    } catch (_e) {
        return null;
    }
}

function hasNotifyProperty(window: Meta.Window, name: string): boolean {
    try {
        const props = (
            window as Meta.Window & {
                list_properties?: () => {
                    name?: string;
                    get_name?: () => string;
                }[];
            }
        ).list_properties?.();
        if (!props) return false;

        return props.some(
            prop => prop.name === name || prop.get_name?.() === name
        );
    } catch (_e) {
        return false;
    }
}

/**
 * Remember the rectangle Tiling Shell just asked Mutter for, and log it when
 * debug-geometry-log is on. Logging never changes the move itself.
 */
export function logGeomRequest(
    reason: string,
    window: Meta.Window,
    rect: RectLike
): void {
    try {
        const target = {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        };
        (window as GeomWindow).__ts_geom_target = target;
        if (!debugOn()) return;

        console.log(
            PREFIX,
            `action=${reason}`,
            windowLabel(window),
            `requested=${rectString(target)}`,
            scaleInfo(window),
            decorationInfo(window)
        );
    } catch (_e) {
        // Geometry logging must not affect tiling.
    }
}

/** Log frame, buffer, and tile geometry for a tiled window. */
export function logGeomSignal(signal: string, window: Meta.Window): void {
    try {
        if (!debugOn()) return;

        const tile = (window as ExtendedWindow).assignedTile;
        if (!tile) return;

        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const tilePx = tilePixel(window);
        const target = (window as GeomWindow).__ts_geom_target;
        console.log(
            PREFIX,
            `signal=${signal}`,
            windowLabel(window),
            `has_focus=${window.has_focus()}`,
            `appears_focused=${window.appears_focused}`,
            `frame=${rectString(frame)}`,
            `buffer=${rectString(buffer)}`,
            `tile=${rectString(tilePx)}`,
            `tile_frac={x:${tile.x},y:${tile.y},w:${tile.width},h:${tile.height}}`,
            `target=${rectString(target)}`,
            `delta_frame_tile=${deltaString(frame, tilePx)}`,
            `delta_frame_target=${deltaString(frame, target)}`,
            scaleInfo(window),
            decorationInfo(window)
        );
    } catch (_e) {
        // Geometry logging must not affect tiling.
    }
}

/**
 * Connects geometry signals only while debug-geometry-log is true, and only
 * logs windows that already have an assigned tile.
 */
class GeomDebug {
    private _settingsId = 0;

    private _focusId = 0;

    private _createdId = 0;

    private _attached = false;

    private readonly _windows = new Map<Meta.Window, number[]>();

    enable(): void {
        this.disable();
        this._settingsId = Settings.connect(
            Settings.KEY_DEBUG_GEOMETRY_LOG,
            () => {
                this._sync();
            }
        );
        this._sync();
    }

    disable(): void {
        if (this._settingsId > 0) {
            Settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._detach(false);
    }

    private _sync(): void {
        if (debugOn()) this._attach();
        else this._detach(true);
    }

    private _attach(): void {
        if (this._attached) return;

        this._attached = true;
        console.log(PREFIX, 'debug-geometry-log=true');
        this._focusId = global.display.connect(
            'focus-window',
            (_display: Meta.Display, window: Meta.Window | null) => {
                if (window) logGeomSignal('focus-window', window);
            }
        );
        this._createdId = global.display.connect(
            'window-created',
            (_display: Meta.Display, window: Meta.Window) => {
                this._track(window);
            }
        );
        global.get_window_actors().forEach(actor => {
            if (actor.metaWindow) this._track(actor.metaWindow);
        });
    }

    private _detach(logOff: boolean): void {
        const wasAttached = this._attached;
        if (this._focusId > 0) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._createdId > 0) {
            global.display.disconnect(this._createdId);
            this._createdId = 0;
        }
        Array.from(this._windows.keys()).forEach(window =>
            this._untrack(window)
        );
        this._attached = false;
        if (logOff && wasAttached)
            console.log(PREFIX, 'debug-geometry-log=false');
    }

    private _track(window: Meta.Window): void {
        if (this._windows.has(window)) return;

        if (hasFocusProperty === null)
            hasFocusProperty = hasNotifyProperty(window, 'has-focus');

        const ids = [
            window.connect('position-changed', () => {
                logGeomSignal('position-changed', window);
            }),
            window.connect('size-changed', () => {
                logGeomSignal('size-changed', window);
            }),
            window.connect('notify::appears-focused', () => {
                logGeomSignal('notify::appears-focused', window);
            }),
            window.connect('unmanaged', () => {
                this._untrack(window);
            }),
        ];
        if (hasFocusProperty) {
            ids.push(
                window.connect('notify::has-focus', () => {
                    logGeomSignal('notify::has-focus', window);
                })
            );
        }
        this._windows.set(window, ids);
    }

    private _untrack(window: Meta.Window): void {
        const ids = this._windows.get(window);
        if (!ids) return;

        this._windows.delete(window);
        ids.forEach(id => {
            try {
                window.disconnect(id);
            } catch (_e) {
                // The window may already be unmanaged.
            }
        });
    }
}

const geomDebug = new GeomDebug();

export function enableGeomDebug(): void {
    geomDebug.enable();
}

export function disableGeomDebug(): void {
    geomDebug.disable();
}
