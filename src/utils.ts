import {ErrorCode, JanusError} from "./errors";

export function randomString(len: number): string {
    const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomString = '';
    for (let i = 0; i < len; i++) {
        const randomPoz = Math.floor(Math.random() * charSet.length);
        randomString += charSet.substring(randomPoz,randomPoz+1);
    }
    return randomString;
}

export function normalizeWebSocketUrl(url: string): string {
    if (!url) {
        throw new JanusError(ErrorCode.INVALID_PARAMS, "websocket url invalid");
    }

    if (!(url.startsWith("//") || url.startsWith("ws://") || url.startsWith("wss://"))) {
        throw new JanusError(ErrorCode.INVALID_PARAMS, "websocket url invalid");
    }

    if (url.startsWith("//")) {
        return (window.location.protocol === "https" ? "wss:" : "ws:") + url;
    }

    return url;
}
