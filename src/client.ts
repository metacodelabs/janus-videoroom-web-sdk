import {VIDEO_CODECS} from "./types";
import { EventEmitter } from 'events';
import type TypedEventEmitter from 'typed-emitter';
import SignalClient from "./signal";
import {JanusID} from "./index";
import {LocalTrack, RemoteAudioTrack, RemoteVideoTrack} from "./track";

export default class JanusClient extends (EventEmitter as new () => TypedEventEmitter<JanusClientCallbacks>) {

    private readonly signal: SignalClient;

    private readonly config: ClientConfig;

    constructor(config: ClientConfig) {
        super();
        this.config = config;
        this.signal = new SignalClient();
        console.log("ClientConfig", this.config);
    }

    public async connect(server: string, token?: string, adminKey?: string): Promise<void> {
        await this.signal.connect(server, token, adminKey);
        await this.signal.attach("publisher");
    }

    public async exists(roomId: JanusID): Promise<boolean> {
        return await this.signal.existsRoom(roomId);
    }

    public async create(roomId: JanusID): Promise<void> {
        return await this.signal.createRoom(roomId);
    }

    public async join(roomId: JanusID, userId: JanusID): Promise<void> {
        this.signal.onPublished = (remoteUserId: JanusID, remoteTrack: RemoteVideoTrack | RemoteAudioTrack): void => {
            console.log(remoteUserId, remoteTrack);
        };

        this.signal.onLeave = (userId: JanusID): void => {
            console.log("onLeave", userId);
        }

        this.signal.onUpdated = (payload: {jsep: any}) => {
            console.log("onUpdated", payload);
        }

        await this.signal.joinPublisher(roomId, userId);
    }

    public async publish(tracks: LocalTrack | LocalTrack[]): Promise<void> {
        if (tracks instanceof LocalTrack) {
            tracks = [tracks];
        }

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });

        pc.oniceconnectionstatechange = () => {
            console.debug("ice state change", {state: pc.iceConnectionState});
        }

        pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                this.signal.sendCandidate(event.candidate, "publisher");
                // this.logger.debug("ice candidate sent", event.candidate);
            } else {
                this.signal.sendCandidateCompleted("publisher");
                console.debug("ice done");
            }
        }

        tracks.forEach((track: LocalTrack) => {
            pc.addTrack(track.getMediaStreamTrack());
        });

        const transceivers = pc.getTransceivers();
        for (const t of transceivers) {
            t.direction = "sendonly";
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const jsep = await this.signal.configureMedia(offer, tracks);
        await pc.setRemoteDescription(jsep);
    }

    public async unpublish(): Promise<void> {
        await this.signal.unpublish();
    }
}

export interface ClientConfig {
    codec: VIDEO_CODECS;
    autoCreateRoom?: boolean;
}

export type JanusClientCallbacks = {
    //
}
