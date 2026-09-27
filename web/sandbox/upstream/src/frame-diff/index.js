import { normalizeArea, rgb, luminance, isIgnored } from "./common.js";

function assertNotAborted(signal) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

function changedPixelMask(args, area) {
    const tolerance = Math.max(0, Math.min(255, Number(args.options?.tolerance ?? 8)));
    const mask = new Uint8Array(area.width * area.height);
    let changed = 0;
    let total = 0;

    for (let y = 0; y < area.height; y++) {
        assertNotAborted(args.signal);
        for (let x = 0; x < area.width; x++) {
            const screenX = area.x + x;
            const screenY = area.y + y;
            if (isIgnored(screenX, screenY, area)) continue;
            const baseline = rgb(args.baseline[screenY * args.width + screenX]);
            const current = rgb(args.current[screenY * args.width + screenX]);
            const delta = Math.max(
                Math.abs(baseline[0] - current[0]),
                Math.abs(baseline[1] - current[1]),
                Math.abs(baseline[2] - current[2])
            );
            total++;
            if (delta >= tolerance) {
                mask[y * area.width + x] = 1;
                changed++;
            }
        }
    }
    return { mask, changed, total };
}

function pixel(args) {
    const area = normalizeArea(args);
    const { changed, total } = changedPixelMask(args, area);
    return {
        ok: true,
        pct: total ? changed / total * 100 : 0,
        debug: { comparedPixels: total, changedPixels: changed }
    };
}

function pixelWindow(args) {
    const area = normalizeArea(args);
    const { mask, changed, total } = changedPixelMask(args, area);
    const windowSize = Math.max(2, Math.min(64, Number(args.options?.windowSize ?? 8)));
    const densityThreshold = Math.max(0, Math.min(1, Number(args.options?.densityThreshold ?? 0.25)));
    let denseWindows = 0;
    let comparedWindows = 0;
    let maxDensity = 0;

    for (let top = 0; top < area.height; top += windowSize) {
        for (let left = 0; left < area.width; left += windowSize) {
            let active = 0;
            let windowPixels = 0;
            for (let y = top; y < Math.min(top + windowSize, area.height); y++) {
                for (let x = left; x < Math.min(left + windowSize, area.width); x++) {
                    const screenX = area.x + x;
                    const screenY = area.y + y;
                    if (isIgnored(screenX, screenY, area)) continue;
                    active += mask[y * area.width + x];
                    windowPixels++;
                }
            }
            if (!windowPixels) continue;
            const density = active / windowPixels;
            maxDensity = Math.max(maxDensity, density);
            comparedWindows++;
            if (density >= densityThreshold) denseWindows++;
        }
    }
    return {
        ok: true,
        pct: comparedWindows ? denseWindows / comparedWindows * 100 : 0,
        debug: {
            comparedPixels: total,
            changedPixels: changed,
            comparedWindows,
            denseWindows,
            maxDensityPct: maxDensity * 100
        }
    };
}

function histogram(args) {
    const area = normalizeArea(args);
    const bins = Number(args.options?.bins ?? 16);
    if (![8, 16, 32].includes(bins)) throw new Error("hist bins must be 8, 16, or 32");
    const baseline = new Uint32Array(bins);
    const current = new Uint32Array(bins);
    let total = 0;

    for (let y = area.y; y < area.y + area.height; y++) {
        assertNotAborted(args.signal);
        for (let x = area.x; x < area.x + area.width; x++) {
            if (isIgnored(x, y, area)) continue;
            baseline[Math.min(bins - 1, luminance(args.baseline[y * args.width + x]) * bins >> 8)]++;
            current[Math.min(bins - 1, luminance(args.current[y * args.width + x]) * bins >> 8)]++;
            total++;
        }
    }
    let distance = 0;
    for (let index = 0; index < bins; index++) {
        distance += Math.abs(baseline[index] - current[index]) / Math.max(1, total);
    }
    return { ok: true, pct: distance * 50, debug: { comparedPixels: total, bins } };
}

function luminancePlane(pixels, width, height) {
    const values = new Uint8Array(width * height);
    for (let index = 0; index < values.length; index++) values[index] = luminance(pixels[index]);
    return values;
}

function blurPlane(source, width, height, radius) {
    if (!radius) return source;
    const blurred = new Uint8Array(source.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            let count = 0;
            for (let offsetY = -radius; offsetY <= radius; offsetY++) {
                const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
                for (let offsetX = -radius; offsetX <= radius; offsetX++) {
                    const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
                    sum += source[sampleY * width + sampleX];
                    count++;
                }
            }
            blurred[y * width + x] = Math.round(sum / count);
        }
    }
    return blurred;
}

function edgePlane(source, width, height) {
    const edges = new Uint8Array(source.length);
    const read = (x, y) => source[
        Math.max(0, Math.min(height - 1, y)) * width
        + Math.max(0, Math.min(width - 1, x))
    ];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            edges[y * width + x] = Math.min(
                255,
                Math.abs(read(x + 1, y) - read(x - 1, y))
                + Math.abs(read(x, y + 1) - read(x, y - 1))
            );
        }
    }
    return edges;
}

function sampleTile(plane, args, area, tileX, tileY, tileSize, sampleGrid) {
    const samples = [];
    const endX = Math.min(tileX + tileSize, area.x + area.width);
    const endY = Math.min(tileY + tileSize, area.y + area.height);
    for (let gridY = 0; gridY < sampleGrid; gridY++) {
        for (let gridX = 0; gridX < sampleGrid; gridX++) {
            const startX = Math.floor(tileX + (endX - tileX) * gridX / sampleGrid);
            const stopX = Math.max(startX + 1, Math.floor(tileX + (endX - tileX) * (gridX + 1) / sampleGrid));
            const startY = Math.floor(tileY + (endY - tileY) * gridY / sampleGrid);
            const stopY = Math.max(startY + 1, Math.floor(tileY + (endY - tileY) * (gridY + 1) / sampleGrid));
            let sum = 0;
            let count = 0;
            for (let y = startY; y < stopY; y++) {
                for (let x = startX; x < stopX; x++) {
                    if (isIgnored(x, y, area)) continue;
                    sum += plane[y * args.width + x];
                    count++;
                }
            }
            samples.push(count ? sum / count : null);
        }
    }
    return samples;
}

function tiled(args, useEdges = false) {
    const area = normalizeArea(args);
    const tileSize = Math.max(4, Math.min(64, Number(args.options?.tileSize ?? 16)));
    const sampleGrid = Math.max(1, Math.min(8, Number(args.options?.sampleGrid ?? 4)));
    const blurRadius = Math.max(0, Math.min(3, Number(args.options?.blurRadius ?? 1)));
    const threshold = Number(args.options?.tileThresholdPct ?? (useEdges ? 10 : 8));
    const trimTopPct = Math.min(40, Math.max(0, Number(args.options?.trimTopPct ?? 20)));
    let baseline = blurPlane(luminancePlane(args.baseline, args.width, args.height), args.width, args.height, blurRadius);
    let current = blurPlane(luminancePlane(args.current, args.width, args.height), args.width, args.height, blurRadius);
    if (useEdges) {
        baseline = edgePlane(baseline, args.width, args.height);
        current = edgePlane(current, args.width, args.height);
    }
    const scores = [];
    for (let tileY = area.y; tileY < area.y + area.height; tileY += tileSize) {
        assertNotAborted(args.signal);
        for (let tileX = area.x; tileX < area.x + area.width; tileX += tileSize) {
            const a = sampleTile(baseline, args, area, tileX, tileY, tileSize, sampleGrid);
            const b = sampleTile(current, args, area, tileX, tileY, tileSize, sampleGrid);
            let difference = 0;
            let samples = 0;
            for (let index = 0; index < a.length; index++) {
                if (a[index] == null || b[index] == null) continue;
                difference += Math.abs(a[index] - b[index]);
                samples++;
            }
            if (samples) scores.push(difference / samples / 255 * 100);
        }
    }
    scores.sort((a, b) => b - a);
    const trimmedTiles = Math.floor(scores.length * trimTopPct / 100);
    const kept = scores.slice(trimmedTiles);
    const changedTiles = kept.filter((value) => value >= threshold).length;
    return {
        ok: true,
        pct: kept.length ? changedTiles / kept.length * 100 : 0,
        debug: {
            rawPct: scores.length ? scores.filter((value) => value >= threshold).length / scores.length * 100 : 0,
            comparedTiles: kept.length,
            trimmedTiles,
            changedTiles
        }
    };
}

const algorithms = new Map([
    ["px", pixel],
    ["px-window", pixelWindow],
    ["hist", histogram],
    ["blk", (args) => tiled(args, false)],
    ["edge", (args) => tiled(args, true)]
]);

export async function compareFramePixels(args) {
    const id = String(args.algorithm || "");
    const algorithm = algorithms.get(id);
    if (!algorithm) throw new Error(`unknown frame algorithm: ${id}`);
    assertNotAborted(args.signal);
    return algorithm(args);
}
