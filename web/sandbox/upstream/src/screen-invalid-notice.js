export const SCREEN_INVALID_NOTICE = "画面を更新するには実行を再開してください。";

export function createScreenInvalidNotice(statusElement) {
    function show() {
        statusElement.dataset.screenInvalidNotice = "true";
        statusElement.textContent = SCREEN_INVALID_NOTICE;
    }

    function clear() {
        if (statusElement.dataset.screenInvalidNotice === "true"
            && statusElement.textContent === SCREEN_INVALID_NOTICE) {
            statusElement.textContent = "";
        }
        delete statusElement.dataset.screenInvalidNotice;
    }

    return Object.freeze({ clear, show });
}
