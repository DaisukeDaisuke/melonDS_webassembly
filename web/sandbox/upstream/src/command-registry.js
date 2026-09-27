import { ErrorCode } from "./error-codes.js";

export function createCommandRegistry({ responder }) {
    const handlers = new Map();
    return {
        register(name, handler) {
            handlers.set(name, handler);
        },
        registerAll(source) {
            Object.entries(source).forEach(([name, handler]) => {
                if (typeof handler === "function") handlers.set(name, handler.bind(source));
            });
        },
        has: (name) => handlers.has(name),
        names: () => [...handlers.keys()],
        execute(name, params = {}) {
            const handler = handlers.get(name);
            if (!handler) {
                return Promise.resolve(responder.fail(ErrorCode.UNKNOWN_COMMAND, `Unknown command: ${name}`));
            }
            return responder.runSafely(name, () => handler(params));
        }
    };
}
