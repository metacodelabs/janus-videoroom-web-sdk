class JTrack {

    protected mediaStreamTrack?: MediaStreamTrack;

    protected mediaElement?: HTMLMediaElement;

    public bitrate?: number;

    public play(container: string | HTMLElement): void {
        if (!this.mediaStreamTrack) {
            throw new Error("janus track play failed, media stream track is not exist");
        }

        let containerEl: HTMLElement | null;
        if (container instanceof HTMLElement) {
            containerEl = container;
        } else {
            containerEl = document.getElementById(container);
        }

        if (!containerEl) {
            throw new Error(` janus track play failed, container element is not exist (${container.toString()})`);
        }

        let el: HTMLMediaElement;
        if (this.mediaStreamTrack.kind === "audio") {
            el = document.createElement("audio");
            el.style.visibility = "hidden";
            el.autoplay = true;
        } else {
            el = document.createElement("video");
            el.style.width = "100%";
            el.style.height = "100%";
            el.style.objectFit = "contain";
            el.setAttribute("muted", "");
            el.setAttribute("playsinline", "");
            el.autoplay = true;
            el.muted = true;
            el.controls = false;
        }
        this.mediaElement = el;
        containerEl.appendChild(el);

        const eventNames = [
            "play", "waiting", "suspend", "loadeddata", "canplay",  "playing", "pause", "stalled", "abort", "ended",
            "emptied",  "error",
        ];

        for (const name of eventNames) {
            el.addEventListener(name, (event) => {
                if (name == "error") {
                    console.log("video error", event.toString());
                } else {
                    console.log(`[${this.mediaStreamTrack?.kind}-track-${this.mediaStreamTrack?.id}] @${name}`);
                }
            });
        }

        el.srcObject = new MediaStream([this.mediaStreamTrack]);

        setTimeout(() => {
            const played = el.play();
            if (played) {
                played.catch((error) => {
                    console.error("playback interrupted", error.toString());
                });
            }
        });
    }

    public stop(): void {
        if (this.mediaStreamTrack) {
            this.mediaStreamTrack.onended = null;
            this.mediaStreamTrack.stop();
        }

        if (this.mediaElement) {
            this.mediaElement.srcObject = null;
            this.mediaElement.remove();
        }
    }

    public isVideo(): boolean {
        return !!this.mediaStreamTrack && this.mediaStreamTrack.kind === "video";
    }

    public isAudio(): boolean {
        return !!this.mediaStreamTrack && this.mediaStreamTrack.kind === "audio";
    }

    public getMediaStreamTrack(): MediaStreamTrack {
        if (!this.mediaStreamTrack) {
            throw new Error("no media stream track");
        }
        return this.mediaStreamTrack;
    }
}

export abstract class LocalTrack extends JTrack {
    protected constructor(mediaStreamTrack: MediaStreamTrack, config?: LocalTrackConfig) {
        super();
        this.mediaStreamTrack = mediaStreamTrack;
        this.bitrate = config?.bitrate;
    }
}

export class LocalVideoTrack extends LocalTrack {
    constructor(mediaStreamTrack: MediaStreamTrack, config: LocalTrackConfig) {
        if (mediaStreamTrack.kind !== "video") {
            throw new Error("media stream track kind is not video.");
        }
        super(mediaStreamTrack, config);
    }
}

export class LocalAudioTrack extends LocalTrack {
    constructor(mediaStreamTrack: MediaStreamTrack, config: LocalTrackConfig) {
        if (mediaStreamTrack.kind !== "audio") {
            throw new Error("media stream track kind is not audio.");
        }
        super(mediaStreamTrack, config);
    }
}

export abstract class RemoteTrack extends JTrack {

    public readonly mid: string;

    public readonly type: string;

    public readonly codec: string;

    protected constructor(mid: string, type: string, codec: string) {
        super();
        this.mid = mid;
        this.type = type;
        this.codec = codec;
    }
}

export class RemoteVideoTrack extends RemoteTrack {

    constructor(mid: string, codec: string) {
        super(mid, "video", codec);
    }
}

export class RemoteAudioTrack extends RemoteTrack {

    constructor(mid: string, codec: string) {
        super(mid, "audio", codec);
    }
}

export interface LocalTrackConfig {
    bitrate?: number;
}
