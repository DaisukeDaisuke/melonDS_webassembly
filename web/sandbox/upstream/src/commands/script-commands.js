import { ErrorCode } from "../error-codes.js";
import { codedError, isPlainObject } from "../validation.js";
import { ResourceLimits } from "../resource-limits.js";
import { normalizeBoundedValue } from "../bounded-value.js";

export function createScriptCommands({
    state,
    ui,
    startPersistentScript,
    stopPersistentScript,
    scriptSummary,
    listPScriptMcps,
    callPScriptMcp,
    renderScriptConsole,
    runSandboxBoundarySelfTest,
    runIsolatedScript,
    runCommand
}) {
    async function runPersistentScript(params = {}) {
        return successfulScriptIdentity(await startPersistentScript(params));
    }

    const SCRIPT_SELECTOR_KEYS = Object.freeze([
        "id", "scriptId", "name", "startupTimeoutMs", "waitForRegistration"
    ]);
    const LOADED_SCRIPT_KEYS = Object.freeze([
        "name", "asyncMode", "startupTimeoutMs", "waitForRegistration"
    ]);
    const CALL_PSCRIPT_MCP_KEYS = Object.freeze([
        "id", "scriptId", "scriptName", "name", "params", "blocking", "timeoutMs"
    ]);

    function exactParamKeys(params, allowed, label) {
        if (!isPlainObject(params)) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${label} params must be a plain object`);
        }
        for (const key of Object.keys(params)) {
            if (!allowed.includes(key)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, `${label}.${key} is not allowed`);
            }
        }
    }

    function requiredScriptName(value, label = "name") {
        if (typeof value !== "string" || !value.trim()) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${label} must be a non-empty string`);
        }
        return value.trim();
    }

    function positiveScriptId(value, label) {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id < 1) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${label} must be a positive safe integer`);
        }
        return id;
    }

    function successfulScriptIdentity(result, expected = {}) {
        if (result?.ok === false) return result;
        if (!Number.isSafeInteger(Number(result?.id)) || Number(result.id) < 1
            || typeof result?.name !== "string" || !result.name) {
            throw codedError(
                ErrorCode.INTERNAL_ERROR,
                "Persistent script startup completed without the required id and name"
            );
        }
        if (result.running !== true || result.started !== true) {
            throw codedError(
                ErrorCode.INTERNAL_ERROR,
                "Persistent script startup returned before running and started were true"
            );
        }
        if (expected.id !== undefined && Number(result.id) !== Number(expected.id)) {
            throw codedError(
                ErrorCode.INTERNAL_ERROR,
                `Persistent script restart changed id from ${expected.id} to ${result.id}`
            );
        }
        if (expected.name !== undefined && result.name !== expected.name) {
            throw codedError(
                ErrorCode.INTERNAL_ERROR,
                `Persistent script startup changed name from ${expected.name} to ${result.name}`
            );
        }
        return result;
    }

    function resolveScript(params, label) {
        exactParamKeys(params, SCRIPT_SELECTOR_KEYS, label);
        const hasId = Object.hasOwn(params, "id");
        const hasScriptId = Object.hasOwn(params, "scriptId");
        const hasName = Object.hasOwn(params, "name");
        const id = hasId ? positiveScriptId(params.id, `${label}.id`) : undefined;
        const scriptId = hasScriptId
            ? positiveScriptId(params.scriptId, `${label}.scriptId`)
            : undefined;
        if (id !== undefined && scriptId !== undefined && id !== scriptId) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${label}.id and ${label}.scriptId must match`);
        }
        const name = hasName ? requiredScriptName(params.name, `${label}.name`) : undefined;
        const selectedId = id ?? scriptId;
        const script = selectedId !== undefined
            ? state.scripts.get(selectedId)
            : name !== undefined
                ? [...state.scripts.values()].find((candidate) => candidate.name === name)
                : state.scripts.get(Number(state.activeScriptId));
        if (!script) throw new Error("script not found");
        if (name !== undefined && script.name !== name) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `${label}.name does not identify the selected script`
            );
        }
        return script;
    }

    async function runLoadedPersistentScript(params = {}) {
        exactParamKeys(params, LOADED_SCRIPT_KEYS, "runLoadedPersistentScript");
        const name = Object.hasOwn(params, "name")
            ? requiredScriptName(params.name, "runLoadedPersistentScript.name")
            : undefined;
        const existing = name === undefined
            ? null
            : [...state.scripts.values()].find((script) => script.name === name);
        const result = await startPersistentScript({
            ...(name === undefined ? {} : { name }),
            ...(Object.hasOwn(params, "asyncMode") ? { asyncMode: !!params.asyncMode } : {}),
            ...(Object.hasOwn(params, "startupTimeoutMs")
                ? { startupTimeoutMs: params.startupTimeoutMs }
                : {}),
            ...(Object.hasOwn(params, "waitForRegistration")
                ? { waitForRegistration: params.waitForRegistration !== false }
                : {})
        }, {
            source: ui.scriptCode.value,
            deduplicateByCode: false
        });
        const identified = successfulScriptIdentity(result, name === undefined ? {} : { name });
        if (identified?.ok === false) return identified;
        return {
            ...identified,
            source: "loaded-editor",
            reloaded: !!existing
        };
    }

    async function listScripts() {
        return { scripts: [...state.scripts.values()].map((script) => scriptSummary(script)) };
    }

    async function listPScriptMcp(params = {}) {
        if (params.scriptId === undefined) return listPScriptMcps();
        const scriptId = Number(params.scriptId);
        if (!Number.isSafeInteger(scriptId) || scriptId < 1) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "scriptId must be a positive safe integer");
        }
        return listPScriptMcps(scriptId);
    }

    async function callPublishedPScriptMcp(params = {}) {
        exactParamKeys(params, CALL_PSCRIPT_MCP_KEYS, "callPScriptMcp");
        if (!Object.hasOwn(params, "name")
            || !Object.hasOwn(params, "blocking")) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "callPScriptMcp requires name and blocking"
            );
        }
        const hasId = Object.hasOwn(params, "id");
        const hasScriptId = Object.hasOwn(params, "scriptId");
        const id = hasId ? positiveScriptId(params.id, "callPScriptMcp.id") : undefined;
        const scriptId = hasScriptId
            ? positiveScriptId(params.scriptId, "callPScriptMcp.scriptId")
            : undefined;
        if (id !== undefined && scriptId !== undefined && id !== scriptId) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "callPScriptMcp.id and callPScriptMcp.scriptId must match"
            );
        }
        const selectedScriptId = id ?? scriptId;
        const scriptName = Object.hasOwn(params, "scriptName")
            ? requiredScriptName(params.scriptName, "callPScriptMcp.scriptName")
            : undefined;
        const name = params.name;
        if (typeof name !== "string"
            || name.length > ResourceLimits.persistentMcpNameChars
            || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name)) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "name must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$"
            );
        }
        if (typeof params.blocking !== "boolean") {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "blocking must be true or false");
        }
        const handlerParams = params.params ?? {};
        if (!isPlainObject(handlerParams)) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "params must be a plain object");
        }
        const timeoutMs = Number(params.timeoutMs ?? 60000);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "timeoutMs must be between 1 and 600000");
        }
        return callPScriptMcp({
            ...(selectedScriptId === undefined ? {} : { scriptId: selectedScriptId }),
            ...(scriptName === undefined ? {} : { scriptName }),
            name,
            params: handlerParams,
            blocking: params.blocking,
            timeoutMs
        });
    }

    async function stopScript(params = {}) {
        const hasId = Object.hasOwn(params, "id"), hasScriptId = Object.hasOwn(params, "scriptId");
        if (!hasId && !hasScriptId) return stopPersistentScript(params);
        const normalizeScriptId = (value, name) => {
            const id = Number(value);
            if (!Number.isSafeInteger(id) || id < 1) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, `${name} must be a positive safe integer`);
            }
            return id;
        };
        const id = hasId ? normalizeScriptId(params.id, "id") : undefined;
        const scriptId = hasScriptId ? normalizeScriptId(params.scriptId, "scriptId") : undefined;
        if (hasId && hasScriptId && id !== scriptId) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "id and scriptId must match");
        }
        return stopPersistentScript({ id: id ?? scriptId });
    }

    async function restartScript(params = {}) {
        const script = resolveScript(params, "restartScript");
        const next = {
            code: script.code,
            asyncMode: script.asyncMode,
            ...(script.identitySource === "api-name" ? { name: script.name } : {}),
            ...(Object.hasOwn(params, "startupTimeoutMs")
                ? { startupTimeoutMs: params.startupTimeoutMs }
                : {}),
            ...(Object.hasOwn(params, "waitForRegistration")
                ? { waitForRegistration: params.waitForRegistration !== false }
                : {})
        };
        await stopPersistentScript({ id: script.id, resumeScriptOnlyTrap: true });
        const result = await startPersistentScript(next, {
            deduplicateByCode: false,
            existingId: script.id
        });
        const identified = successfulScriptIdentity(result, {
            id: script.id,
            ...(script.identitySource === "api-name" ? { name: script.name } : {})
        });
        if (identified?.ok === false) return identified;
        return {
            ...identified,
            reloaded: true
        };
    }

    async function getScript(params = {}) {
        const script = state.scripts.get(Number(params.id ?? state.activeScriptId));
        if (!script) throw new Error("script not found");
        const pattern = params.pattern ?? params.regex;
        if (pattern != null || params.flags != null) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "getScript regular-expression search is unavailable; retrieve the bounded source instead"
            );
        }
        const originalChars = script.code.length;
        const code = script.code.slice(0, ResourceLimits.scriptSourceOutputChars);
        return {
            id: script.id,
            name: script.name,
            code,
            truncated: code.length !== originalChars,
            originalChars
        };
    }

    async function listScriptPrint(params = {}) {
        const max = Math.max(1, Number(params.max ?? 10));
        const startLine = params.startLine == null ? null : Number(params.startLine);
        if (startLine !== null && (!Number.isSafeInteger(startLine) || startLine < 1)) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "startLine must be a positive safe integer");
        }
        const hasId = Object.hasOwn(params, "id"), hasScriptId = Object.hasOwn(params, "scriptId");
        const id = hasId ? positiveScriptId(params.id, "listScriptPrint.id") : undefined;
        const scriptId = hasScriptId ? positiveScriptId(params.scriptId, "listScriptPrint.scriptId") : undefined;
        if (id !== undefined && scriptId !== undefined && id !== scriptId) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "listScriptPrint id and scriptId must match");
        }
        const hasSelector = hasId || hasScriptId;
        const hasName = Object.hasOwn(params, "name");
        if (hasSelector && hasName) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "listScriptPrint accepts either id/scriptId or name, not both");
        }
        const selectedId = id ?? scriptId;
        const scripts = hasSelector
            ? [state.scripts.get(selectedId)].filter(Boolean)
            : hasName
                ? [...state.scripts.values()].filter((script) => script.name === requiredScriptName(params.name, "listScriptPrint.name"))
                : [...state.scripts.values()];
        const consoles = scripts.map((script) => {
            const outputStartLine = Number.isSafeInteger(script.outputStartLine)
                ? script.outputStartLine
                : 1;
            const nextOutputLine = Number.isSafeInteger(script.nextOutputLine)
                ? script.nextOutputLine
                : outputStartLine + script.output.length;
            const startIndex = startLine === null
                ? Math.max(0, script.output.length - max)
                : Math.max(0, startLine - outputStartLine);
            const selectedOutput = script.output.slice(startIndex, startIndex + max);
            return {
                id: script.id,
                name: script.name,
                firstLine: outputStartLine,
                lastLine: nextOutputLine - 1,
                nextLine: nextOutputLine,
                lineCount: script.output.length,
                logs: selectedOutput.map((text, index) => ({
                    id: script.id,
                    name: script.name,
                    line: outputStartLine + startIndex + index,
                    text
                }))
            };
        });
        const matching = consoles.flatMap((console) => console.logs);
        const logs = startLine === null ? matching.slice(-max) : matching.slice(0, max);
        const selectedConsole = consoles.length === 1 ? consoles[0] : null;
        return {
            logs,
            firstLine: logs[0]?.line ?? null,
            lastLine: logs.at(-1)?.line ?? null,
            ...(selectedConsole ? {
                id: selectedConsole.id,
                name: selectedConsole.name,
                availableFirstLine: selectedConsole.firstLine,
                availableLastLine: selectedConsole.lastLine,
                nextLine: selectedConsole.nextLine,
                lineCount: selectedConsole.lineCount
            } : { consoles: consoles.map(({ logs: _logs, ...console }) => console) })
        };
    }

    async function clearScriptPrint(params = {}) {
        const hasId = Object.hasOwn(params, "id"), hasScriptId = Object.hasOwn(params, "scriptId");
        const id = hasId ? positiveScriptId(params.id, "clearScriptPrint.id") : undefined;
        const scriptId = hasScriptId ? positiveScriptId(params.scriptId, "clearScriptPrint.scriptId") : undefined;
        if (id !== undefined && scriptId !== undefined && id !== scriptId) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "clearScriptPrint id and scriptId must match");
        }
        const hasSelector = hasId || hasScriptId;
        const hasName = Object.hasOwn(params, "name");
        if (hasSelector && hasName) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "clearScriptPrint accepts either id/scriptId or name, not both");
        }
        const selectedId = id ?? scriptId;
        const scripts = hasSelector
            ? [state.scripts.get(selectedId)].filter(Boolean)
            : hasName
                ? [...state.scripts.values()].filter((script) => script.name === requiredScriptName(params.name, "clearScriptPrint.name"))
                : [...state.scripts.values()];
        scripts.forEach((script) => {
            script.output = [];
            script.outputStartLine = Number.isSafeInteger(script.nextOutputLine)
                ? script.nextOutputLine
                : 1;
        });
        renderScriptConsole();
        return {
            ok: true,
            cleared: scripts.map((script) => script.id),
            consoles: scripts.map((script) => ({
                id: script.id,
                nextLine: script.outputStartLine
            }))
        };
    }

    async function evaluate(params = {}) {
        return runIsolatedScript(String(params.code ?? ""), Number(params.timeoutMs ?? 3000));
    }

    async function runScript(params = {}) {
        return evaluate(params);
    }

    async function sandboxBoundarySelfTest(params = {}) {
        if (Object.keys(params).length) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "runSandboxBoundarySelfTest accepts no parameters");
        }
        return runSandboxBoundarySelfTest();
    }

    async function injectScript(params = {}) {
        return runIsolatedScript(
            String(params.code ?? ui.scriptCode.value),
            Number(params.timeoutMs ?? 3000)
        );
    }

    async function batch(params = {}) {
        const items = Array.isArray(params.commands) ? params.commands : [];
        if (!items.length) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "batch requires { commands: [...] } with at least one command"
            );
        }
        if (items.length > ResourceLimits.batchCommands) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `batch supports at most ${ResourceLimits.batchCommands} commands`,
                { maximum: ResourceLimits.batchCommands, received: items.length }
            );
        }
        const results = [];
        let resultBytes = 0;
        for (const item of items) {
            if (!isPlainObject(item)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "batch items must be plain objects");
            }
            const command = String(item.command ?? item.name ?? "");
            if (!command) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "batch item is missing command");
            }
            if (command === "batch") {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "nested batch commands are unavailable");
            }
            const rawResult = await runCommand(command, item.params || {});
            let bounded;
            try {
                bounded = normalizeBoundedValue({ command, result: rawResult }, {
                    maxBytes: ResourceLimits.batchResultBytes - resultBytes
                });
            } catch (error) {
                const reason = String(error?.message || error);
                if (!reason.includes("exceeds byte budget")) {
                    throw codedError(
                        ErrorCode.INVALID_ARGUMENT,
                        `batch result for ${command} is not a supported structured value`,
                        { completedCommands: results.length, command, reason }
                    );
                }
                throw codedError(
                    ErrorCode.INVALID_ARGUMENT,
                    `batch results exceed ${ResourceLimits.batchResultBytes} bytes`,
                    { maximumBytes: ResourceLimits.batchResultBytes, completedCommands: results.length }
                );
            }
            resultBytes += bounded.bytes;
            results.push(bounded.value);
        }
        return { results };
    }

    return Object.freeze({
        batch,
        callPScriptMcp: callPublishedPScriptMcp,
        clearScriptPrint,
        eval: evaluate,
        getScript,
        injectScript,
        listScriptPrint,
        listPScriptMcp,
        listScripts,
        restartScript,
        runLoadedPersistentScript,
        runSandboxBoundarySelfTest: sandboxBoundarySelfTest,
        runPersistentScript,
        runScript,
        stopScript
    });
}
