import { ErrorCode } from "./error-codes.js";
import { unwrapLegacyScalar } from "./legacy-scalar.js";

const LOCAL_SECURITY_CONTEXT = "Local-only security boundary: ROM, save, and state bytes are not uploaded; no runtime CDN executable code or third-party WebMCP script is loaded; cross-origin and opaque-origin message calls are ignored; injected JavaScript runs in network-, DOM-, and storage-disabled sandbox Workers. Exact-version Acorn and SSIM dependencies are bundled locally; Acorn runs only in a dependency-only parser Worker with no emulator RPC, and SSIM executes only in a network- and storage-disabled algorithm Worker. Chrome DevTools evaluate_script is a privileged local diagnostic outside the page sandbox boundary.";

export function registerWebMcp({ commands, descriptions, responder, runCommand, compact, installShortcuts, logger }) {
    const toContent = (result) => responder.toWebMcpContent(result, compact);
    const parseInput = (input) => {
        try {
            if (typeof input !== "string") return responder.ok({ value: input || {} });
            if (!input.trim()) return responder.ok({ value: {} });
            return responder.ok({ value: JSON.parse(input) });
        } catch (error) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "WebMCP input is not valid JSON", {
                message: String(error?.message || error)
            });
        }
    };
    const executeParsed = async (input, handler) => {
        const parsed = parseInput(input);
        if (!parsed.ok) return toContent(parsed);
        return toContent(await handler(parsed.value));
    };
    const callLegacyScalar = async (command, params) => unwrapLegacyScalar(
        await runCommand(command, params),
        command
    );

    installShortcuts(runCommand);
    window.DesmumeMCP = {
        call: runCommand,
        list: () => Object.fromEntries(Object.keys(commands).map((name) => [name, descriptions[name] || ""])),
        shortcuts: () => window.DesmumeShortcuts || {}
    };
    window.memory = {
        getregister: (register, cpu) => callLegacyScalar("memoryGetRegister", { register, cpu }),
        setregister: (register, value, cpu) => runCommand("memorySetRegister", { register, value, cpu }),
        readbyte: (address, cpu) => callLegacyScalar("memoryReadByte", { address, cpu }),
        readword: (address, cpu) => callLegacyScalar("memoryReadWord", { address, cpu }),
        readdword: (address, cpu) => callLegacyScalar("memoryReadDword", { address, cpu }),
        writebyte: (address, value, cpu) => runCommand("memoryWriteByte", { address, value, cpu }),
        writeword: (address, value, cpu) => runCommand("memoryWriteWord", { address, value, cpu }),
        writedword: (address, value, cpu) => runCommand("memoryWriteDword", { address, value, cpu })
    };
    window.memory.reg = window.memory.getregister;
    window.memory.regw = window.memory.setregister;
    window.memory.read8 = window.memory.readbyte;
    window.memory.read16 = window.memory.readword;
    window.memory.read32 = window.memory.readdword;
    window.memory.write8 = window.memory.writebyte;
    window.memory.write16 = window.memory.writeword;
    window.memory.write32 = window.memory.writedword;

    async function registerBrowserTools() {
        const modelContext = ("modelContext" in document && document.modelContext)
            || ("modelContext" in navigator && navigator.modelContext);
        if (!modelContext || typeof modelContext.registerTool !== "function") return false;
        const registrations = [{
            name: "desmume.list",
            title: "DeSmuME command list",
            description: `Lists available DeSmuME Web Debugger commands and their short descriptions. ${LOCAL_SECURITY_CONTEXT}`,
            inputSchema: { type: "object", additionalProperties: false },
            annotations: { readOnlyHint: true },
            execute: async () => toContent(window.DesmumeMCP.list())
        }, {
            name: "desmume.call",
            title: "DeSmuME command",
            description: "Runs one DeSmuME Web Debugger command locally by name. Memory and debugger results are returned only to the native WebMCP caller or the exact same-origin message caller.",
            inputSchema: {
                type: "object",
                required: ["command"],
                properties: {
                    command: { type: "string" },
                    params: { type: "object", additionalProperties: true }
                },
                additionalProperties: false
            },
            execute: (input = {}) => executeParsed(input, (parsed) => runCommand(
                String(parsed.command || ""),
                parsed.params || {}
            ))
        }, {
            name: "desmume.eval",
            title: "DeSmuME eval",
            description: "Runs isolated JavaScript with mcp.call(command, params) in a Worker without network, DOM, sub-Worker, localStorage, sessionStorage, IndexedDB, Cache API, or raw postMessage access.",
            inputSchema: {
                type: "object",
                required: ["code"],
                properties: {
                    code: { type: "string" },
                    timeoutMs: { type: "number" }
                },
                additionalProperties: false
            },
            execute: (input = {}) => executeParsed(input, (parsed) => commands.eval(parsed))
        }, {
            name: "desmume.runScript",
            title: "DeSmuME run script",
            description: "Alias for desmume.eval with the same network-, DOM-, storage-, and raw-message-disabled Worker boundary.",
            inputSchema: {
                type: "object",
                required: ["code"],
                properties: {
                    code: { type: "string" },
                    timeoutMs: { type: "number" }
                },
                additionalProperties: false
            },
            execute: (input = {}) => executeParsed(input, (parsed) => commands.runScript(parsed))
        }];
        let registered = 0;
        for (const tool of registrations) {
            try {
                await modelContext.registerTool(tool);
                registered++;
            } catch (error) {
                if (/already|duplicate/i.test(String(error?.message || error))) registered++;
                else console.warn("WebMCP register failed", tool.name, error);
            }
        }
        logger(`WebMCP registered ${registered} tools`);
        return registered > 0;
    }

    window.addEventListener("message", async (event) => {
        if (event.origin !== window.location.origin) return;
        const message = event.data || {};
        if (message.type !== "desmume-mcp") return;
        const params = message.params ?? {};
        const paramsPrototype = params && typeof params === "object"
            ? Object.getPrototypeOf(params)
            : undefined;
        const validParams = paramsPrototype === Object.prototype || paramsPrototype === null;
        const result = typeof message.command === "string" && validParams
            ? await runCommand(message.command, params)
            : responder.fail(
                ErrorCode.INVALID_ARGUMENT,
                "message command must be a string and params must be a plain object"
            );
        event.source?.postMessage(
            { type: "desmume-mcp-result", id: message.id, result },
            window.location.origin
        );
    });
    void registerBrowserTools().catch((error) => logger(error?.message || String(error)));
    return { registerBrowserTools };
}
