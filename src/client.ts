import {VIDEO_CODECS} from "./types";
import { EventEmitter } from 'events';
import type TypedEventEmitter from 'typed-emitter';
import SignalClient from "./signal";
import {JanusID} from "./index";
import {LocalTrack, RemoteAudioTrack, RemoteTrack, RemoteTrackMap, RemoteVideoTrack} from "./track";
import PromiseQueue from "promise-queue";
import {Logger} from "ts-log";

export default class JanusClient extends (EventEmitter as new () => TypedEventEmitter<JanusClientCallbacks>) {

    private readonly signal: SignalClient;

    private readonly config: ClientConfig;

    private subscribeQueue: PromiseQueue;

    private trackMap: RemoteTrackMap;

    private log: Logger;

    private publisherPc?: RTCPeerConnection;

    private subscriberPc?: RTCPeerConnection;

    private innerEmitter: EventEmitter;

    constructor(config: ClientConfig, log: Logger = console) {
        super();
        this.config = config;
        this.signal = new SignalClient();
        this.subscribeQueue = new PromiseQueue(1);
        this.trackMap = new RemoteTrackMap();
        this.innerEmitter = new EventEmitter();
        this.log = log;
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
            this.emit("user-published", remoteUserId, remoteTrack);
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
        this.publisherPc = pc;

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
        this.publisherPc = undefined;
    }

    async subscribe(userId: JanusID, track: RemoteTrack): Promise<void> {
        await this.subscribeQueue.add(() => this.doSubscribe(userId, track));
    }

    async doSubscribe(userId: JanusID, track: RemoteTrack): Promise<void> {
        if (!this.subscriberPc) {
            await this.createSubscriber(userId, track);
            return ;
        }

        const pc = this.subscriberPc;

        const p = new Promise<void>((resolve) => {
            this.innerEmitter.once("__ontrack", (mediaTrack: MediaStreamTrack) => {
                this.log.warn("__ontrack", mediaTrack);
                track.setMediaStreamTrack(mediaTrack.clone());
                resolve();
            });
        });

        const subscription = await this.signal.subscribe(userId, track);
        this.trackMap.update(subscription.tracksMap);
        this.trackMap.setTrack(userId, track.mid, track);

        await pc.setRemoteDescription(subscription.jsep);
        const transceivers = pc.getTransceivers();
        for (const t of transceivers) {
            t.direction = "recvonly";
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await this.signal.startSubscriber(answer);

        return p;
    }

    private async createSubscriber(userId: JanusID, track: RemoteTrack): Promise<void> {
        this.log.warn("create subscriber");

        const p = new Promise<void>((resolve) => {
            this.innerEmitter.once("__ontrack", (mediaTrack: MediaStreamTrack) => {
                this.log.warn("__ontrack", mediaTrack);
                track.setMediaStreamTrack(mediaTrack.clone());
                resolve();
            });
        });

        await this.signal.attach("subscriber");

        const subscription = await this.signal.joinSubscriber(userId, track);
        this.trackMap.update(subscription.tracksMap);
        this.trackMap.setTrack(userId, track.mid, track);

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        this.subscriberPc = pc;

        pc.oniceconnectionstatechange = () => {
            this.log.debug("subscriber ice state change", {state: pc.iceConnectionState});
        }

        pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                this.signal.sendCandidate(event.candidate, "subscriber");
                // this.logger.debug("subscriber ice candidate sent", event.candidate);
            } else {
                this.signal.sendCandidateCompleted("subscriber");
                // subscriber.iceDone = true;
                this.log.debug("subscriber ice done");
            }
        }

        pc.ontrack = (event: RTCTrackEvent) => {
            this.log.debug("subscriber ontrack", event);

            let onmuteTimer: ReturnType<typeof setTimeout> | undefined;

            event.track.onended = (ev) => {
                this.log.debug("track onended");
                if (onmuteTimer) {
                    clearTimeout(onmuteTimer);
                }
                this.handleTrackUnpublish(ev);
            }

            event.track.onmute = (ev) => {
                this.log.debug("track onmute");
                if (onmuteTimer) {
                    clearTimeout(onmuteTimer);
                }
                onmuteTimer = setTimeout(() => {
                    this.handleTrackUnpublish(ev);
                }, 2000);
            }

            event.track.onunmute = (ev) => {
                this.log.debug("track onunmute", ev);
                if (onmuteTimer) {
                    clearTimeout(onmuteTimer);
                }
            }

            // this.trackPool.putMediaTrack(event.transceiver.mid as string, event.track);
            this.innerEmitter.emit("__ontrack", event.track);
        }

        await pc.setRemoteDescription(subscription.jsep);
        const transceivers = pc.getTransceivers();
        for (const t of transceivers) {
            t.direction = "recvonly";
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await this.signal.startSubscriber(answer);

        return p;
    }

    public async leave(): Promise<void> {
        await this.signal.destroy();

        if (this.publisherPc) {
            this.publisherPc.oniceconnectionstatechange = null;
            this.publisherPc.onicecandidate = null;
            this.publisherPc = undefined;
        }

        if (this.subscriberPc) {
            this.subscriberPc.oniceconnectionstatechange = null;
            this.subscriberPc.onicecandidate = null;
            this.subscriberPc = undefined;
        }
    }

    private handleTrackUnpublish(ev: Event) {
        this.log.debug(`user unpublish from ${ev.type} event`);
        const transceivers = this.subscriberPc?.getTransceivers();
        if (transceivers) {
            const transceiver = transceivers.find(t => t.receiver.track === ev.target);
            if (transceiver) {
                const evTrack = this.trackMap.getTrack(transceiver.mid as string);
                const evUser = this.trackMap.getUser(transceiver.mid as string);
                if (evTrack && evUser) {
                    this.log.debug("@user-unpublished", evUser, evTrack);
                    this.emit("user-unpublished", evUser, evTrack);
                } else {
                    this.log.warn("user unpublish failed, remote track or user not found", evUser, evTrack);
                }
            } else {
                this.log.warn("user unpublish failed, not found mid");
            }
        } else {
            this.log.warn("user unpublish failed, no transceivers");
        }
    }
}

export interface ClientConfig {
    codec: VIDEO_CODECS;
    autoCreateRoom?: boolean;
}

export type JanusClientCallbacks = {
    "user-published": (remoteUserId: JanusID, remoteTrack: RemoteTrack) => Promise<void>;

    "user-unpublished": (remoteUserId: JanusID, remoteTrack: RemoteTrack) => Promise<void>;
}
