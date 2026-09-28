/**
 * The `sysMapAreaChanged(newAreaID, prevAreaID)` a centerview raises, or null
 * when it raises none.
 *
 * Moving into another area raises it, as does the first centerview since the
 * map widget opened (or its map was replaced) even when the room lies in the
 * area already on show: that area is only the view restored from last time,
 * and desktop reports the first centerview with -2 as the previous area.
 */
export function centerviewAreaChange(
    first: boolean, prevArea: number | null, areaId: number,
): [number, number] | null {
    if (first) return [areaId, -2];
    if (prevArea === areaId) return null;
    return [areaId, prevArea ?? -1];
}
