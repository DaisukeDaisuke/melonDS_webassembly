import { ErrorCode } from "../error-codes.js";
import { withInternalMetadata } from "../internal-command-metadata.js";
import { positiveInteger, subscribeAbort } from "../validation.js";
import { createOrderedFrameDrain } from "../ordered-frame-drain.js";

export function registerWaitCommands({
    commands,
    descriptions,
    responder,
    operationManager,
    breakpointOwners,
    breakpointService,
    scriptPauseService,
    pauseEventService = scriptPauseService,
    stateLoadEventService,
    fileTransactionEventService,
    frameService,
    inputSequenceService,
    inputRecordingService,
    getNativeStatus,
    parseAddress,
    hex,
    getFrame,
    getActivity = () => ({})
}) {
    const pauseKindForBreakType = (type) => type === "exec"
        ? "executeBreakpoint"
        : type === "read" || type === "write"
            ? "memoryBreakpoint"
            : "specialBreakpoint";
    async function runWatcher(name, timeoutValue, waitForEvent) {
        const timeoutMs = positiveInteger(timeoutValue, "timeoutMs", 600000);
        const controller = new AbortController();
        let timer = 0;
        try {
            const result = await Promise.race([
                Promise.resolve(waitForEvent(controller.signal)).then((value) => ({ value })),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
                })
            ]);
            if (result.timedOut) {
                controller.abort("timeout");
                return responder.fail(ErrorCode.TIMEOUT, `${name} timed out`, { timeoutMs });
            }
            return result.value;
        } finally {
            clearTimeout(timer);
            if (!controller.signal.aborted) controller.abort("settled");
        }
    }
    function raceScriptPause(operation, waitForValue) {
        const afterSerial = scriptPauseService.currentSerial();
        const controller = new AbortController();
        const abortFromOperation = () => controller.abort(operation.signal.reason);
        const unsubscribeOperationAbort = subscribeAbort(operation.signal, abortFromOperation);
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                unsubscribePause();
                unsubscribeOperationAbort();
                if (!controller.signal.aborted) controller.abort("settled");
            };
            const settle = (method, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                method(value);
            };
            const unsubscribePause = scriptPauseService.subscribe((event) => {
                if (event.serial <= afterSerial) return;
                settle(resolve, { scriptPause: event });
            });
            Promise.resolve(waitForValue(controller.signal)).then(
                (value) => settle(resolve, { value }),
                (error) => settle(reject, error)
            );
        });
    }

    function scriptPausedResult(event) {
        return responder.fail(
            ErrorCode.SCRIPT_PAUSED,
            "A persistent script explicitly paused the emulator",
            { scriptId: event.scriptId }
        );
    }

    commands.waitForBreak = async (params = {}) => {
        const includeScripts = params.scriptBreakpoints === "include";
        if (!breakpointOwners.hasWaitableBreakpoints({ includeScripts })) {
            return responder.fail(ErrorCode.NO_WAITABLE_BREAKPOINTS, "No non-script breakpoints are enabled");
        }
        return operationManager.run({
            name: "waitForBreak",
            timeoutMs: Number(params.timeoutMs),
            task: async (operation) => {
                const afterSerial = breakpointService.currentSerial();
                const pending = raceScriptPause(operation, (signal) => breakpointService.waitForEvent({
                    afterSerial,
                    scriptBreakpoints: params.scriptBreakpoints,
                    signal
                }));
                const native = getNativeStatus();
                if (native?.lastBreak?.hit && Number(native.lastBreak.kind) === 0) {
                    const stepped = await commands.step(withInternalMetadata({ count: 1 }, { operation: true }));
                    if (stepped?.ok === false) return stepped;
                }
                const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                if (resumed?.ok === false) return resumed;
                const waited = await pending;
                if (waited.scriptPause) return scriptPausedResult(waited.scriptPause);
                const event = waited.value;
                await commands.pause(withInternalMetadata({}, { operation: true }));
                return responder.ok({
                    cpu: event.cpu,
                    type: event.type,
                    address: hex(event.address),
                    pc: hex(event.pc)
                });
            }
        });
    };

    commands.runUntil = async (params = {}) => {
        const hasPc = params.pc !== undefined;
        const hasBreakpoint = params.bp !== undefined;
        if (hasPc === hasBreakpoint) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "runUntil requires exactly one of pc or bp");
        }
        const progress = { hits: 0, expectedHits: 1 };
        return operationManager.run({
            name: "runUntil",
            timeoutMs: Number(params.timeoutMs),
            timeoutDetails: () => hasBreakpoint ? { ...progress } : {},
            task: async (operation) => {
                let temporaryId = 0;
                let predicate;
                if (hasPc) {
                    const address = parseAddress(params.pc, 0, params.cpu);
                    const result = await commands.setBreakpoint(withInternalMetadata({
                        cpu: params.cpu,
                        type: "exec",
                        address,
                        enabled: true
                    }, { origin: "operation", operationId: operation.id }));
                    temporaryId = result.id;
                    predicate = (event) => event.type === "exec" && event.address === address;
                } else {
                    const id = Number(params.bp);
                    const site = breakpointOwners.findBreakpointById(id);
                    if (!site) {
                        return responder.fail(ErrorCode.BREAKPOINT_NOT_FOUND, `Breakpoint not found: ${id}`);
                    }
                    if (breakpointOwners.classifySite(site).scriptOnly && params.scriptBreakpoints !== "include") {
                        return responder.fail(ErrorCode.BREAKPOINT_NOT_WAITABLE, `Breakpoint is script-only: ${id}`);
                    }
                    progress.expectedHits = positiveInteger(params.hits ?? 1, "hits", 1000000);
                    predicate = (event) => event.owners.some((owner) => owner.id === id);
                }
                let afterSerial = breakpointService.currentSerial();
                try {
                    while (progress.hits < progress.expectedHits) {
                        const pending = raceScriptPause(operation, (signal) => breakpointService.waitForEvent({
                            afterSerial,
                            scriptBreakpoints: params.scriptBreakpoints,
                            predicate,
                            signal
                        }));
                        const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                        if (resumed?.ok === false) return resumed;
                        const waited = await pending;
                        if (waited.scriptPause) return scriptPausedResult(waited.scriptPause);
                        const event = waited.value;
                        afterSerial = event.serial;
                        progress.hits++;
                        if (progress.hits < progress.expectedHits) {
                            if (event.type === "exec") {
                                const stepped = await commands.step(withInternalMetadata({ count: 1 }, { operation: true }));
                                if (stepped?.ok === false) return stepped;
                            }
                            continue;
                        }
                        await commands.pause(withInternalMetadata({}, { operation: true }));
                        return responder.ok({
                            pc: hex(event.pc),
                            pauseKind: pauseKindForBreakType(event.type),
                            ...(event.type && event.type !== "exec" ? { breakType: event.type } : {}),
                            ...(hasPc ? {} : { bp: Number(params.bp), hits: progress.hits }),
                            frames: getFrame()
                        });
                    }
                } finally {
                    if (temporaryId) breakpointOwners.removeOwner(temporaryId);
                }
            }
        });
    };

    commands.runInputSequence = async (params = {}) => operationManager.run({
        name: "runInputSequence",
        timeoutMs: Number(params.timeoutMs ?? 600000),
        task: (operation) => inputSequenceService.run(params, operation)
    });
    commands.listInputSequences = async () => inputSequenceService.list();
    commands.deleteInputSequence = async (params = {}) => inputSequenceService.delete(params);
    commands.recordInput = async (params = {}) => operationManager.run({
        name: "recordInput",
        timeoutMs: Number(params.timeoutMs),
        task: (operation) => inputRecordingService.record(params, operation)
    });
    commands.replayInput = async (params = {}) => operationManager.run({
        name: "replayInput",
        timeoutMs: Number(params.timeoutMs),
        task: (operation) => inputRecordingService.replay(params, operation)
    });
    commands.listInputRecordings = async () => inputRecordingService.list();
    commands.deleteInputRecording = async (params = {}) => inputRecordingService.delete(params);
    commands.captureFrame = async (params = {}) => frameService.captureFrame(params);
    commands.listFrameSnapshots = async () => frameService.listFrameSnapshots();
    commands.deleteFrameSnapshot = async (params = {}) => frameService.deleteFrameSnapshot(params);
    commands.compareFrame = async (params = {}) => frameService.compareFrame(params);

    function pausedOperationResult(event, label) {
        if (event.pauseKind === "scriptPause") {
            return responder.fail(ErrorCode.SCRIPT_PAUSED, `${label} was interrupted by a persistent script`, event);
        }
        if (event.pauseKind === "nativeFault") {
            return responder.fail(ErrorCode.NATIVE_FAULT, `${label} was interrupted by a native fault`, event);
        }
        return responder.fail(
            ErrorCode.BREAKPOINT_INTERRUPTED,
            `${label} was interrupted by ${event.pauseKind || "pause"}`,
            event
        );
    }

    async function waitForComparedFrames(params, {
        name,
        label,
        initialBaseline,
        successWhen,
        advanceBaseline = false
    }) {
        if (!params.algorithm || !Number.isFinite(Number(params.thresholdPct))) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "algorithm and thresholdPct are required");
        }
        const progress = { maxPct: 0 };
        return operationManager.run({
            name,
            timeoutMs: Number(params.timeoutMs),
            timeoutDetails: () => ({ maxPct: progress.maxPct }),
            task: async (operation) => {
                const initialPause = await commands.pause(withInternalMetadata({}, { operation: true }));
                if (initialPause?.ok === false) return initialPause;
                let baseline = initialBaseline();
                if (!baseline?.ok) return baseline;
                const stableFrames = positiveInteger(params.stableFrames ?? 1, "stableFrames", 1000000);
                const sampleEvery = positiveInteger(params.sampleEveryFrames ?? 1, "sampleEveryFrames", 1000000);
                const maxQueue = positiveInteger(params.maxQueue ?? 32, "maxQueue", 256);
                let stable = 0;
                let finishWait = () => {};
                const waiting = new Promise((resolve, reject) => {
                    let finished = false;
                    let drain = null;
                    let unsubscribePause = () => {};
                    let unsubscribeAbort = () => {};
                    const cleanup = () => {
                        drain?.stop();
                        unsubscribePause();
                        unsubscribeAbort();
                    };
                    const finish = (result) => {
                        if (finished) return;
                        finished = true;
                        cleanup();
                        Promise.resolve(commands.pause(withInternalMetadata({}, { operation: true }))).then(
                            (paused) => resolve(paused?.ok === false ? paused : result),
                            reject
                        );
                    };
                    finishWait = finish;
                    const aborted = () => {
                        if (finished) return;
                        finished = true;
                        cleanup();
                        reject(new DOMException("aborted", "AbortError"));
                    };
                    drain = createOrderedFrameDrain({
                        frameService,
                        sampleEveryFrames: sampleEvery,
                        maxQueue,
                        onSample: async (sample, stats) => {
                            const compareCaptured = frameService.compareCapturedPixels
                                ? () => frameService.compareCapturedPixels(
                                    baseline.pixels,
                                    sample.pixels,
                                    {
                                        ...params,
                                        signal: operation.signal
                                    }
                                )
                                : () => frameService.comparePixels(baseline.pixels, {
                                ...params,
                                signal: operation.signal
                                });
                            const result = await compareCaptured();
                            if (finished) return;
                            if (!result.ok) return finish(result);
                            progress.maxPct = Math.max(progress.maxPct, result.pct);
                            stable = successWhen(result) ? stable + 1 : 0;
                            if (advanceBaseline) {
                                baseline = {
                                    ok: true,
                                    pixels: new Uint32Array(sample.pixels),
                                    frame: sample.frame
                                };
                            }
                            if (stable >= stableFrames) {
                                return finish(responder.ok({
                                    matched: name === "waitForFrameMatch",
                                    stable: name === "waitForScreenStable",
                                    changed: name === "waitForScreenChange",
                                    algorithm: params.algorithm,
                                    pct: result.pct,
                                    frame: sample.frame,
                                    frames: stats.completedFrames,
                                    ...(params.debug ? { sampledFrames: stats.sampledFrames } : {})
                                }));
                            }
                        },
                        onOverflow: ({ frame, serial, maxQueue: limit }) => finish(responder.fail(
                            ErrorCode.RESOURCE_LIMIT,
                            `${label} sample queue exceeded ${limit}`,
                            { frame, serial, maxQueue: limit }
                        )),
                        onError: (error) => finish(error?.ok === false ? error : responder.fail(
                            error?.mcpCode || ErrorCode.INTERNAL_ERROR,
                            String(error?.message || error)
                        ))
                    });
                    const pauseAfterSerial = pauseEventService.currentSerial();
                    unsubscribePause = pauseEventService.subscribe((event) => {
                        if (event.serial <= pauseAfterSerial) return;
                        void finish(pausedOperationResult(event, label));
                    });
                    unsubscribeAbort = subscribeAbort(operation.signal, aborted);
                });
                if (operation.signal.aborted) return waiting;
                const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                if (resumed?.ok === false) finishWait(resumed);
                return waiting;
            }
        });
    }

    commands.waitForScreenChange = async (params = {}) => waitForComparedFrames(params, {
        name: "waitForScreenChange",
        label: "Screen wait",
        initialBaseline: () => frameService.captureCurrent(),
        successWhen: (result) => result.changed
    });

    commands.waitForFrameMatch = async (params = {}) => {
        const snapshot = frameService.getSnapshot(params.id);
        if (!snapshot) {
            return responder.fail(
                ErrorCode.FRAME_SNAPSHOT_NOT_FOUND,
                `Frame snapshot not found: ${params.id}`
            );
        }
        return waitForComparedFrames(params, {
            name: "waitForFrameMatch",
            label: "Frame match wait",
            initialBaseline: () => snapshot,
            successWhen: (result) => result.pct <= Number(params.thresholdPct)
        });
    };

    function runUntilMemoryAccess(type, params = {}) {
        const progress = { hits: 0, expectedHits: 1 };
        return operationManager.run({
            name: type === "read" ? "runUntilMemoryRead" : "runUntilMemoryWrite",
            timeoutMs: Number(params.timeoutMs),
            timeoutDetails: () => ({ ...progress }),
            task: async (operation) => {
                const cpu = String(params.cpu || "arm9").toLowerCase();
                if (!["arm9", "arm7"].includes(cpu)) {
                    return responder.fail(ErrorCode.INVALID_ARGUMENT, "cpu must be arm9 or arm7");
                }
                const address = parseAddress(params.address, 0, cpu);
                progress.expectedHits = positiveInteger(params.hits ?? 1, "hits", 1000000);
                const created = await commands.setBreakpoint(withInternalMetadata({
                    cpu,
                    type,
                    address,
                    enabled: true
                }, { origin: "operation", operationId: operation.id }));
                if (created?.ok === false) return created;
                const temporaryId = created.id;
                let afterSerial = breakpointService.currentSerial();
                try {
                    while (progress.hits < progress.expectedHits) {
                        const pending = raceScriptPause(operation, (signal) => breakpointService.waitForEvent({
                            afterSerial,
                            scriptBreakpoints: params.scriptBreakpoints,
                            predicate: (event) => (
                                event.type === type
                                && event.cpu === cpu
                                && event.address === address
                                && event.owners.some((owner) => owner.id === temporaryId)
                            ),
                            signal
                        }));
                        const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                        if (resumed?.ok === false) return resumed;
                        const eventResult = await pending;
                        if (eventResult.scriptPause) return scriptPausedResult(eventResult.scriptPause);
                        const event = eventResult.value;
                        afterSerial = event.serial;
                        progress.hits++;
                        if (progress.hits < progress.expectedHits) continue;
                        await commands.pause(withInternalMetadata({}, { operation: true }));
                        return responder.ok({
                            cpu,
                            address: hex(event.address),
                            pc: hex(event.pc),
                            value: hex(event.value),
                            size: Number(event.size || 0),
                            hits: progress.hits,
                            pauseKind: "memoryBreakpoint",
                            breakType: type,
                            frame: getFrame()
                        });
                    }
                } finally {
                    breakpointOwners.removeOwner(temporaryId);
                }
            }
        });
    }

    commands.runUntilMemoryRead = async (params = {}) => runUntilMemoryAccess("read", params);
    commands.runUntilMemoryWrite = async (params = {}) => runUntilMemoryAccess("write", params);

    commands.waitForScreenStable = async (params = {}) => waitForComparedFrames(params, {
        name: "waitForScreenStable",
        label: "Screen stability wait",
        initialBaseline: () => frameService.captureCurrent(),
        successWhen: (result) => result.pct < Number(params.thresholdPct),
        advanceBaseline: true
    });

    commands.waitForPause = async (params = {}) => {
        const allowedKinds = new Set([
            "manual", "executeBreakpoint", "memoryBreakpoint", "specialBreakpoint",
            "scriptPause", "nativeFault"
        ]);
        if (params.kinds !== undefined && (
            !Array.isArray(params.kinds)
            || !params.kinds.length
            || params.kinds.some((kind) => !allowedKinds.has(kind))
        )) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "kinds contains an unsupported pause kind");
        }
        return operationManager.run({
            name: "waitForPause",
            timeoutMs: Number(params.timeoutMs),
            task: async (operation) => {
                const event = await pauseEventService.waitForEvent({
                    afterSerial: params.afterSerial === undefined
                        ? pauseEventService.currentSerial()
                        : Number(params.afterSerial),
                    kinds: params.kinds,
                    signal: operation.signal
                });
                return responder.ok({ ...event, frame: Number(event.frame ?? getFrame()), ...getActivity() });
            }
        });
    };

    commands.waitForStateLoad = async (params = {}) => runWatcher(
        "waitForStateLoad",
        params.timeoutMs,
        async (signal) => {
            const afterSerial = Number(params.afterSerial ?? 0);
            if (!Number.isSafeInteger(afterSerial) || afterSerial < 0) {
                return responder.fail(ErrorCode.INVALID_ARGUMENT, "afterSerial must be a non-negative integer");
            }
            const event = await stateLoadEventService.waitForEvent({
                afterSerial: 0,
                predicate: (candidate) => candidate.stateLoadSerial > afterSerial,
                signal
            });
            return responder.ok({ ...event, ...getActivity() });
        }
    );

    commands.waitForFileTransaction = async (params = {}) => runWatcher(
        "waitForFileTransaction",
        params.timeoutMs,
        async (signal) => {
            const afterSerial = Number(params.afterSerial ?? 0);
            if (!Number.isSafeInteger(afterSerial) || afterSerial < 0) {
                return responder.fail(ErrorCode.INVALID_ARGUMENT, "afterSerial must be a non-negative integer");
            }
            const idle = params.idle !== false;
            const event = await fileTransactionEventService.waitForEvent({
                afterSerial: 0,
                predicate: (candidate) => (
                    candidate.fileTransactionSerial > afterSerial
                    && (!idle || candidate.active === false)
                ),
                signal
            });
            return responder.ok({
                fileTransactionSerial: event.fileTransactionSerial,
                fileTransactionActive: event.active,
                phase: event.phase,
                ...getActivity()
            });
        }
    );

    Object.assign(descriptions, {
        waitForBreak: "通常breakpointの次のhitまで待機します。timeoutMsは必須です。",
        runUntil: "PC到達またはbreakpoint hit回数まで実行します。",
        runUntilMemoryRead: "CPUによる指定memory readのhit回数まで実行し、最後のhitで停止します。",
        runUntilMemoryWrite: "CPUによる指定memory writeのhit回数まで実行し、最後のhitで停止します。",
        runInputSequence: "実行中に保存・再利用可能な短い入力sequenceを実行します。停止中はerrorになり、手動pauseだけresume:trueを指定できます。",
        listInputSequences: "保存済み入力sequenceを返します。",
        deleteInputSequence: "保存済み入力sequenceを削除します。",
        recordInput: "実際のDS入力をcompleted frame offset基準で記録します。timeoutMsは必須です。",
        replayInput: "記録済み入力をframe offsetどおり再生し、既定では停止して返します。",
        listInputRecordings: "入力recordingのmetadata一覧を返します。",
        deleteInputRecording: "入力recording、event、関連Stateを削除します。",
        captureFrame: "現在の有効frameを名前付きsnapshotへ保存します。",
        listFrameSnapshots: "frame snapshot一覧を返します。",
        deleteFrameSnapshot: "frame snapshotを削除します。",
        compareFrame: "保存済みframeと現在frameを指定algorithmで比較します。",
        waitForScreenChange: "開始時frameを固定baselineとして画面変化を待ちます。",
        waitForFrameMatch: "保存済みframe snapshotとの一致を順序付きsampleで待ちます。",
        waitForScreenStable: "連続sample間の画面差分が閾値未満で安定するまで待ちます。",
        waitForPause: "serialより後の指定種別のpause通知を待ちます。",
        waitForStateLoad: "State適用serialが進むまで待ちます。",
        waitForFileTransaction: "file transactionのserial進行と完了を待ちます。"
    });
}
