import Tile from '../../components/layout/Tile';
import { Mtk, Meta } from '../../gi/ext';

interface ExtendedWindow extends Meta.Window {
    originalSize: Mtk.Rectangle | undefined;
    assignedTile: Tile | undefined;
    // Tile and monitor remembered while a tiled window is maximized.
    // Cleared once the window is restored, untiled, moved, or unmanaged.
    tileBeforeMaximize?: Tile;
    monitorBeforeMaximize?: number;
}

export default ExtendedWindow;
