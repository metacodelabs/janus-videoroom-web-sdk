export class JanusError extends Error {

    public readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(`${message} (${code})`);
        this.name = "JanusError";
        this.code = code;
    }
}

export enum ErrorCode {
    UNEXPECTED_ERROR = "UNEXPECTED_ERROR",
    INVALID_OPERATION = "INVALID_OPERATION",
    INVALID_PARAMS = "INVALID_PARAMS",
    WS_ERR = "WS_ERR",
    SIGNAL_ERROR = "SIGNAL_ERROR",
}
