export function normalizeArea({ width, height, screen = "both", region, ignoreRects = [] }) {
    const baseY = screen === "bottom" ? 192 : 0;
    const areaHeight = screen === "both" ? 384 : 192;
    if (!["top", "bottom", "both"].includes(screen)) {
        throw new Error("screen must be top, bottom, or both");
    }
    if (region !== undefined && (!Array.isArray(region) || region.length !== 4)) {
        throw new Error("region must contain four numbers");
    }
    if (!Array.isArray(ignoreRects)) throw new Error("ignoreRects must be an array");
    const box = region || [0, 0, 256, areaHeight];
    const [x, y, boxWidth, boxHeight] = box.map(Number);
    const invalidBox = ![x, y, boxWidth, boxHeight].every(Number.isInteger)
        || x < 0
        || y < 0
        || boxWidth <= 0
        || boxHeight <= 0
        || x + boxWidth > width
        || y + boxHeight > areaHeight;
    if (invalidBox) throw new Error("region is outside the selected screen");
    const ignored = ignoreRects.map((rect) => {
        if (!Array.isArray(rect) || rect.length !== 4) {
            throw new Error("ignoreRects contains an invalid rectangle");
        }
        return rect.map(Number);
    });
    const invalidIgnoredRect = ignored.some(([rectX, rectY, rectWidth, rectHeight]) => (
        ![rectX, rectY, rectWidth, rectHeight].every(Number.isInteger)
        || rectX < 0
        || rectY < 0
        || rectWidth <= 0
        || rectHeight <= 0
        || rectX + rectWidth > width
        || rectY + rectHeight > areaHeight
    ));
    if (invalidIgnoredRect) throw new Error("ignoreRects contains an invalid rectangle");
    return { x, y: y + baseY, width: boxWidth, height: boxHeight, baseY, ignored };
}

export const rgb = (pixel) => [
    pixel & 255,
    (pixel >>> 8) & 255,
    (pixel >>> 16) & 255
];

export const luminance = (pixel) => {
    const [red, green, blue] = rgb(pixel);
    return (77 * red + 150 * green + 29 * blue) >> 8;
};

export const isIgnored = (x, y, area) => area.ignored.some(([
    rectX,
    rectY,
    rectWidth,
    rectHeight
]) => (
    x >= rectX
    && x < rectX + rectWidth
    && y - area.baseY >= rectY
    && y - area.baseY < rectY + rectHeight
));
