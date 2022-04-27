import {JanusID} from "./index";
import {Logger} from "ts-log";
import {ErrorCode, JanusError} from "./errors";
import {TrackKind} from "./types";
import {EventEmitter} from "events";

const mediaElementEvents = [
    "play", "waiting", "suspend", "loadeddata", "canplay",  "playing", "pause", "stalled", "abort", "ended",
    "emptied",  "error",
];

export abstract class JanusTrack extends EventEmitter {

    protected mediaStreamTrack?: MediaStreamTrack;

    protected mediaElement?: HTMLMediaElement;

    public bitrate?: number;

    private mediaElementHandler?: (evt: Event) => void;

    protected constructor() {
        super();
    }

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

        this.mediaElementHandler = (evt: Event): void => {
            if (evt.type == "error") {
                console.log("video error", evt.toString());
            } else {
                console.log(`[${this.mediaStreamTrack?.kind}-track-${this.mediaStreamTrack?.id}] @${evt.type}`);
            }
        }

        for (const name of mediaElementEvents) {
            el.addEventListener(name, this.mediaElementHandler.bind(this));
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
        console.log(`stop ${this.toString()}`);

        if (this.mediaElement) {
            if (this.mediaElementHandler) {
                for (const name of mediaElementEvents) {
                    this.mediaElement.removeEventListener(name, this.mediaElementHandler);
                }
            }

            this.mediaElement.srcObject = null;
            this.mediaElement.remove();
            this.mediaElement = undefined;
        }

        if (this.mediaStreamTrack) {
            this.mediaStreamTrack.onended = null;
            this.mediaStreamTrack.onmute = null;
            this.mediaStreamTrack.onunmute = null;
            this.mediaStreamTrack.stop();
            this.mediaStreamTrack = undefined;
        }
    }

    get kind(): TrackKind | undefined {
        return this.mediaStreamTrack?.kind as TrackKind;
    }

    public getMediaStreamTrack(): MediaStreamTrack {
        if (!this.mediaStreamTrack) {
            throw new Error("no media stream track");
        }
        return this.mediaStreamTrack;
    }

    public toString(): string {
        if (!this.mediaStreamTrack) {
            return "track(none)";
        }

        return `track(${this.mediaStreamTrack.kind}, ${this.mediaStreamTrack.id}, ${this.mediaStreamTrack.label})`;
    }
}

export abstract class LocalTrack extends JanusTrack {
    protected constructor(mediaStreamTrack: MediaStreamTrack, config?: LocalTrackConfig) {
        super();
        this.mediaStreamTrack = mediaStreamTrack;
        this.bitrate = config?.bitrate;
        mediaStreamTrack.onended = () => {
            this.emit("ended");
        }
    }

    public setMuted(muted: boolean): void {
        if (!this.mediaStreamTrack) {
            throw new JanusError(ErrorCode.INVALID_OPERATION, "local track set muted failed, no media stream track.");
        }

        this.mediaStreamTrack.enabled = !muted;
    }

    public replace(newTrack: MediaStreamTrack) {
        if (!this.mediaStreamTrack) {
            throw new JanusError(ErrorCode.INVALID_OPERATION, "set new media stream track failed, old track does not exist.");
        }

        if (newTrack.kind != this.mediaStreamTrack.kind) {
            throw new JanusError(ErrorCode.INVALID_OPERATION, "set new media stream track failed, new and old tracks have different kind.");
        }

        const oldTrack = this.mediaStreamTrack;
        this.mediaStreamTrack = newTrack;

        if (this.mediaElement) {
            this.mediaElement.srcObject = new MediaStream([newTrack]);
            const played = this.mediaElement.play();
            if (played) {
                played.catch(err => {
                    console.error("playback interrupted", err.toString());
                });
            }
        }

        this.emit("replace-track", newTrack, oldTrack);
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

    public abstract setMediaStreamTrack(track: MediaStreamTrack): void;

}

export class RemoteVideoTrack extends RemoteTrack {

    constructor(mid: string, codec: string) {
        super(mid, codec);
    }

    get kind(): "audio" | "video" {
        return "video";
    }

    public setMediaStreamTrack(track: MediaStreamTrack): void {
        if (track.kind !== "video") {
            throw new Error("media stream track kind is not video.");
        }

        this.mediaStreamTrack = track;
    }
}

export class RemoteAudioTrack extends RemoteTrack {

    constructor(mid: string, codec: string) {
        super(mid, codec);
    }

    get kind(): "audio" | "video" {
        return "audio";
    }

    public setMediaStreamTrack(track: MediaStreamTrack): void {
        if (track.kind !== "audio") {
            throw new Error("media stream track kind is not audio.");
        }
        this.mediaStreamTrack = track;
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

    public getUserTracks(userId: JanusID): RemoteTrack[] {
        const tracks: RemoteTrack[] = [];
        this.map.forEach((m)=> {
            if (m.userId != userId) {
                return ;
            }
            const track = this.getTrack(m.formalMid);
            if (!track) {
                return ;
            }
            tracks.push(track);
        });
        return tracks;
    }

    public getUser(formalMid: string): JanusID | null {
        const item = this.map.find( m => m.formalMid == formalMid);

        if (!item) {
            return null;
        }

        return item.userId;
    }

    public clear(): void {
        this.map = [];
        this.tracks.clear();
    }
}
