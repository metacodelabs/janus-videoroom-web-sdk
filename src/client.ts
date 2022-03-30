import {VIDEO_CODECS} from "./types";
import {EventEmitter} from 'events';
import type TypedEventEmitter from 'typed-emitter';
import SignalClient, {Jsep, Subscription} from "./signal";
import {JanusID} from "./index";
import {LocalTrack, RemoteAudioTrack, RemoteTrack, RemoteTrackMap, RemoteVideoTrack} from "./track";
import PromiseQueue from "promise-queue";
import {Logger} from "ts-log";
import {ErrorCode, JanusError} from "./errors";

export default class JanusClient extends (EventEmitter as new () => TypedEventEmitter<JanusClientCallbacks>) {

    public readonly remoteUsers: Map<JanusID, RemoteUserSubscribed>;

    private readonly config: ClientConfig;

    private signal: SignalClient;

    private subscribeQueue: PromiseQueue;

    private trackMap: RemoteTrackMap;

    private log: Logger;

    private publisherPc?: RTCPeerConnection;

    private subscriberPc?: RTCPeerConnection;

    private innerEmitter: EventEmitter;

    private _connectionState: ConnectionState;

    private isJoined: boolean;

    get connectionState(): ConnectionState {return this._connectionState}

    constructor(config: ClientConfig, log: Logger = console) {
        super();
        this.config = config;
        this.log = log;
        this.remoteUsers = new Map();
        this.subscribeQueue = new PromiseQueue(1);
        this.trackMap = new RemoteTrackMap();
        this.innerEmitter = new EventEmitter();
        this.isJoined = false;
        this._connectionState = "DISCONNECTED";
        this.signal = new SignalClient();
        this.registerSignalHandler();
    }

    public async connect(server: string, token?: string, adminKey?: string): Promise<void> {
        this.log.info(`connect signal server: ${server}`);
        this.changeConnectionState("CONNECTING");
        await this.signal.connect(server, token, adminKey);
        await this.signal.attach("publisher");
        this.changeConnectionState("CONNECTED");
    }

    public async exists(roomId: JanusID): Promise<boolean> {
        return await this.signal.existsRoom(roomId);
    }

    public async create(roomId: JanusID): Promise<void> {
        return await this.signal.createRoom(roomId);
    }

    private registerSignalHandler(): void {
        this.signal.onDisconnect = (reason: string): void => {
            this.reset();
            this.changeConnectionState("DISCONNECTED", ConnectionDisconnectedReason.NETWORK_ERROR);
        }

        this.signal.onPublished = (remoteUserId: JanusID, remoteTrack: RemoteTrack): void => {
            this.log.info(`emit user-published event (uid: ${remoteUserId}, mid: ${remoteTrack.mid}, codec: ${remoteTrack.codec})`);
            this.emit("user-published", remoteUserId, remoteTrack);
        }

        this.signal.onLeave = async (userId: JanusID): Promise<void> => {
            await this.signal.unsubscribe(userId);
            this.log.info(`emit user-left event (uid: ${userId})`);
            this.emit("user-left", userId);
        }

        this.signal.onUpdated = async (jsep: Jsep): Promise<void> => {
            this.log.debug("on updated", jsep);
            const pc = this.subscriberPc;
            if (!pc) {
                throw new JanusError(ErrorCode.UNEXPECTED_ERROR, "no subscriber pc");
            }
            await pc.setRemoteDescription(jsep);
            const transceivers = pc.getTransceivers();
            for (const t of transceivers) {
                t.direction = "recvonly";
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await this.signal.startSubscriber(answer);
        }
    }

    public async join(roomId: JanusID, userId: JanusID): Promise<void> {
        if (this.isJoined) {
            throw new JanusError(ErrorCode.INVALID_OPERATION, "Already joined");
        }
        this.isJoined = true;

        this.log.info(`join room (room id: ${roomId}, user id: ${userId})`);

        await this.signal.joinPublisher(roomId, userId);

        this.log.info("room joined");
    }

    public async publish(tracks: LocalTrack | LocalTrack[]): Promise<void> {
        if (tracks instanceof LocalTrack) {
            tracks = [tracks];
        }

        this.log.info(`publish tracks [${tracks.toString()}]`);

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        this.publisherPc = pc;

        pc.oniceconnectionstatechange = () => {
            this.log.info(`publisher pc ice connection state changed: ${pc.iceConnectionState}`);
        }

        pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                this.signal.sendCandidate(event.candidate, "publisher");
            } else {
                this.signal.sendCandidateCompleted("publisher");
                this.log.debug("publisher pc send candidate completed");
            }
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/connectionState
        pc.onconnectionstatechange = () => {
            this.log.info(`publisher pc connection state changed: ${pc.connectionState}`);
            if (pc.connectionState === "failed") {
                this.signal.close();
                this.reset();
                this.changeConnectionState("DISCONNECTED", ConnectionDisconnectedReason.NETWORK_ERROR);
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
        let subscription: Subscription;
        if (!this.subscriberPc) {
            await this.signal.attach("subscriber");
            this.subscriberPc = this.createSubscriberPC();
            subscription = await this.signal.joinSubscriber(userId, track);
        } else {
            subscription = await this.signal.subscribe(userId, track);
        }

        const p = new Promise<void>((resolve) => {
            this.innerEmitter.once("track", (mediaTrack: MediaStreamTrack) => {
                track.setMediaStreamTrack(mediaTrack.clone());

                let subscribedUser = this.remoteUsers.get(userId);
                if (!subscribedUser) {
                    subscribedUser = new RemoteUserSubscribed(userId);
                    this.remoteUsers.set(userId, subscribedUser);
                }

                if (track instanceof RemoteVideoTrack) {
                    if (subscribedUser.videoTrack) {
                        throw new JanusError(ErrorCode.INVALID_OPERATION, `user video track is already subscribed (uid: ${userId})`);
                    }
                    subscribedUser.videoTrack = track;
                } else if (track instanceof RemoteAudioTrack) {
                    if (subscribedUser.audioTrack) {
                        throw new JanusError(ErrorCode.INVALID_OPERATION, `user audio track is already subscribed (uid: ${userId})`);
                    }
                    subscribedUser.audioTrack = track;
                }

                this.log.info(`track subscribed (uid: ${userId}, ${track.toString()})`);
                resolve();
            });
        });

        this.trackMap.update(subscription.tracksMap);
        this.trackMap.setTrack(userId, track.mid, track);

        const pc = this.subscriberPc;
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

    private createSubscriberPC(): RTCPeerConnection {

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

            this.innerEmitter.emit("track", event.track);
        }

        return pc;
    }

    public async leave(): Promise<void> {
        this.changeConnectionState("DISCONNECTING");
        await this.signal.destroy();
        this.reset();
        this.changeConnectionState("DISCONNECTED", ConnectionDisconnectedReason.LEAVE);
    }

    private reset(): void {
        this.remoteUsers.forEach((user: RemoteUserSubscribed, userId: JanusID) => {
            if (user.audioTrack) {
                user.audioTrack.stop();
                user.audioTrack = undefined;
            }

            if (user.videoTrack) {
                user.videoTrack.stop();
                user.videoTrack = undefined;
            }
        });
        this.remoteUsers.clear();

        if (this.publisherPc) {
            this.publisherPc.oniceconnectionstatechange = null;
            this.publisherPc.onicecandidate = null;
            this.publisherPc.ontrack = null;
            this.publisherPc.close();
            this.publisherPc = undefined;
        }

        if (this.subscriberPc) {
            this.subscriberPc.getTransceivers().forEach((t) => {
                if (t.receiver && t.receiver.track) {
                    const tk = t.receiver.track;
                    tk.onmute = null;
                    tk.onunmute = null;
                    tk.onended = null;
                    tk.stop();
                }
            });
            this.subscriberPc.oniceconnectionstatechange = null;
            this.subscriberPc.onicecandidate = null;
            this.subscriberPc.ontrack = null;
            this.subscriberPc.close();
            this.subscriberPc = undefined;
        }

        this.innerEmitter.removeAllListeners();
        this.trackMap.clear();
        this.subscribeQueue = new PromiseQueue(1);
        this.isJoined = false;
    }

    private handleTrackUnpublish(ev: Event) {
        const transceivers = this.subscriberPc?.getTransceivers();
        if (transceivers) {
            const transceiver = transceivers.find(t => t.receiver.track === ev.target);
            if (transceiver) {
                const evTrack = this.trackMap.getTrack(transceiver.mid as string);
                const evUser = this.trackMap.getUser(transceiver.mid as string);
                if (evTrack && evUser) {
                    this.log.info(`emit user-unpublished event (uid: ${evUser}, kind: ${evTrack.getTrackKind()})`);
                    const subscribedUser = this.remoteUsers.get(evUser);
                    if (subscribedUser) {
                        if (evTrack instanceof RemoteAudioTrack) {
                            subscribedUser.audioTrack?.stop();
                            subscribedUser.audioTrack = undefined;
                        } else if (evTrack instanceof RemoteVideoTrack) {
                            subscribedUser.videoTrack?.stop();
                            subscribedUser.videoTrack = undefined;
                        }

                        if (!subscribedUser.audioTrack && !subscribedUser.videoTrack) {
                            this.remoteUsers.delete(evUser);
                        }
                    }

                    this.emit("user-unpublished", evUser, evTrack);
                } else {
                    this.log.warn(`user unpublish failed, remote track or user not found`, evUser, evTrack);
                }
            } else {
                this.log.warn("user unpublish failed, not found mid");
            }
        } else {
            this.log.warn("user unpublish failed, no transceivers");
        }
    }

    private changeConnectionState(state: ConnectionState, reason?: ConnectionDisconnectedReason): void {
        const prevState = this._connectionState;
        this._connectionState = state;
        this.log.info(`connection state: ${prevState} -> ${state}`, (reason ? `(reason: ${reason})` : ''));
        this.emit("connection-state-change", state, prevState, reason);
    }
}

export interface ClientConfig {
    codec: VIDEO_CODECS;
}

export type JanusClientCallbacks = {
    "user-published": (remoteUserId: JanusID, remoteTrack: RemoteTrack) => Promise<void> | void;

    "user-unpublished": (remoteUserId: JanusID, remoteTrack: RemoteTrack) => Promise<void> | void;

    "user-left": (remoteUserId: JanusID) => Promise<void> | void;

    "connection-state-change": (currState: ConnectionState, prevState: ConnectionState, reason?: ConnectionDisconnectedReason) => void;
}

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DISCONNECTING";

export enum ConnectionDisconnectedReason {
    LEAVE = "LEAVE",
    KICKED = "KICKED",
    NETWORK_ERROR = "NETWORK_ERROR",
}

export class RemoteUserSubscribed {

    public readonly userId: JanusID;

    public audioTrack?: RemoteAudioTrack;

    public videoTrack?: RemoteVideoTrack;

    constructor(userId: JanusID) {
        this.userId = userId;
    }
}
