import {JanusID} from "./index";
import {Logger} from "ts-log";

class JanusTrack {

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
            this.mediaStreamTrack.onmute = null;
            this.mediaStreamTrack.onunmute = null;
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

    public getTrackKind(): "audio" | "video" | null {
        if (this.isVideo()) {
            return "video";
        }

        if (this.isAudio()) {
            return "audio";
        }

        return null;
    }

    public getMediaStreamTrack(): MediaStreamTrack {
        if (!this.mediaStreamTrack) {
            throw new Error("no media stream track");
        }
        return this.mediaStreamTrack;
    }

    public setMediaStreamTrack(track: MediaStreamTrack) {
        this.mediaStreamTrack = track;
    }

    public toString(): string {
        if (!this.mediaStreamTrack) {
            return "JanusTrack(None)";
        }

        return `Track(${this.mediaStreamTrack.kind}, ${this.mediaStreamTrack.id}, ${this.mediaStreamTrack.label})`;
    }
}

export abstract class LocalTrack extends JanusTrack {
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

export abstract class RemoteTrack extends JanusTrack {

    public readonly mid: string;

    public readonly codec: string;

    protected constructor(mid: string, codec: string) {
        super();
        this.mid = mid;
        this.codec = codec;
    }
}

export class RemoteVideoTrack extends RemoteTrack {

    constructor(mid: string, codec: string) {
        super(mid, codec);
    }

    public setMediaStreamTrack(track: MediaStreamTrack) {
        if (track.kind !== "video") {
            throw new Error("media stream track kind is not video.");
        }
        super.setMediaStreamTrack(track);
    }
}

export class RemoteAudioTrack extends RemoteTrack {

    constructor(mid: string, codec: string) {
        super(mid, codec);
    }

    public setMediaStreamTrack(track: MediaStreamTrack) {
        if (track.kind !== "audio") {
            throw new Error("media stream track kind is not audio.");
        }
        super.setMediaStreamTrack(track);
    }
}

export interface LocalTrackConfig {
    bitrate?: number;
}

export interface TrackMidMap {
    type: "audio" | "video";

    userId: JanusID;

    tmpMid: string;

    formalMid: string;
}


export class RemoteTrackMap {

    private log: Logger;

    map: TrackMidMap[] = [];

    tracks: Map<string, RemoteTrack> = new Map<string, RemoteTrack>();

    constructor(log: Logger = console) {
        this.log = log;
    }

    public update(map: TrackMidMap[]): void {
        this.log.debug("remote track map update", map);
        this.map = map;
    }

    public setTrack(userId: JanusID, tmpMid: string, track: RemoteTrack): void {
        const item = this.map.find( m => m.userId == userId && m.tmpMid == tmpMid);
        if (item) {
            this.tracks.set(item.formalMid, track);
            this.log.debug(`remote track map set track (userId: ${userId}, formalMid: ${item.formalMid})`, track);
        } else {
            this.log.warn(`remote track map set track failed (userId: ${userId}, tmpMid: ${tmpMid})`, track);
        }
    }

    public getTrack(formalMid: string): RemoteTrack | null {
        const track = this.tracks.get(formalMid);
        return track ? track : null;
    }

    public getUser(formalMid: string): JanusID | null {
        const item = this.map.find( m => m.formalMid == formalMid);

        if (!item) {
            return null;
        }

        return item.userId;
    }
}
