import {VIDEO_CODECS} from "./types";
import {EventEmitter} from 'events';
import type TypedEventEmitter from 'typed-emitter';
import SignalClient, {Jsep, Subscription} from "./signal";
import {JanusID} from "./index";
import {LocalTrack, RemoteAudioTrack, RemoteTrack, RemoteTrackMap, RemoteVideoTrack} from "./track";
import PromiseQueue from "promise-queue";
import {Logger} from "ts-log";
import {ErrorCode, JanusError} from "./errors";
import WebrtcStats, {NetworkQuality, StatsResult} from "./stats";
import {LocalAudioTrackStats, LocalVideoTrackStats} from "./stats";

const maxReconnectRetries = 10;
const maxReconnectDuration = 60 * 1000;

export default class JanusClient extends (EventEmitter as new () => TypedEventEmitter<JanusClientCallbacks>) {

    public readonly remoteUsers: Map<JanusID, RemoteUserSubscribed>;

    private readonly config: ClientConfig;

    private signal: SignalClient;

    private subscribeQueue: PromiseQueue;

    private trackMap: RemoteTrackMap;

    private log: Logger;

    private publisherPc?: RTCPeerConnection;

    private subscriberPc?: RTCPeerConnection;

    private publishedTracks: LocalTrack[];

    private innerEmitter: EventEmitter;

    private _connectionState: ConnectionState;

    private isJoined: boolean;

    private reconnectAttempts: number;

    private reconnectStart: number;

    get connectionState(): ConnectionState {return this._connectionState}

    private publisherStats?: WebrtcStats;

    private networkQualityTimer?: ReturnType<typeof setInterval>;

    constructor(config: ClientConfig, log: Logger = console) {
        super();
        this.config = config;
        this.log = log;
        this.remoteUsers = new Map();
        this.subscribeQueue = new PromiseQueue(1);
        this.trackMap = new RemoteTrackMap();
        this.innerEmitter = new EventEmitter();
        this.publishedTracks = [];
        this.isJoined = false;
        this.reconnectAttempts = 0;
        this.reconnectStart = 0;
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

    private handleDisconnect(attemptsNext = false): void {
        if (!attemptsNext && this.connectionState === "RECONNECTING") {
            return ;
        }

        if (this.reconnectAttempts === 0) {
            this.changeConnectionState("RECONNECTING");
            this.reconnectStart = Date.now();
        }

        const delay = (this.reconnectAttempts * this.reconnectAttempts) * 300;
        setTimeout(async () => {
            if (this.connectionState !==  "RECONNECTING") {
                return ;
            }

            try {
                this.log.debug("reconnect attempts", this.reconnectAttempts);

                await this.signal.reconnect();

                if (this.publisherPc) {
                    this.log.info("publisher pc ice restart");
                    if (this.publishedTracks.length < 1) {
                        throw new JanusError(ErrorCode.UNEXPECTED_ERROR, "no published tracks.");
                    }

                    const pc = this.publisherPc;

                    const offer = await pc.createOffer({iceRestart: true});
                    await pc.setLocalDescription(offer);
                    const jsep = await this.signal.configureMedia(offer, this.publishedTracks);
                    await pc.setRemoteDescription(jsep);
                }

                if (this.subscriberPc) {
                    this.log.info("subscriber pc ice restart");
                    const jsep = await this.signal.restartSubscriberIce();
                    const pc = this.subscriberPc;
                    await pc.setRemoteDescription(jsep);
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    await this.signal.startSubscriber(answer);
                }

                this.reconnectAttempts = 0;
                this.reconnectStart = 0;
                this.changeConnectionState("CONNECTED");
            } catch (err) {
                this.log.error("reconnect error: ", err);
                this.reconnectAttempts += 1;
                const duration = Date.now() - this.reconnectStart;
                if (this.reconnectAttempts >= maxReconnectRetries || duration > maxReconnectDuration) {
                    this.signal.close();
                    this.reset();
                    this.changeConnectionState("DISCONNECTED");
                } else {
                    this.handleDisconnect(true);
                }
            }

        }, delay);
    }

    private registerSignalHandler(): void {
        this.signal.onDisconnect = (reason: string): void => {
            this.handleDisconnect();
        }

        this.signal.onPublished = (remoteUserId: JanusID, remoteTrack: RemoteTrack): void => {
            this.log.info(`emit user-published event (uid: ${remoteUserId}, mid: ${remoteTrack.mid}, codec: ${remoteTrack.codec})`);
            this.emit("user-published", remoteUserId, remoteTrack);
        }

        this.signal.onUnpublished = (remoteUserId: JanusID): void  => {
            this.log.info(`emit user-unpublished event (uid: ${remoteUserId})`);
            this.emit("user-unpublished", remoteUserId);
            const user = this.remoteUsers.get(remoteUserId);
            if (user) {
                user.audioTrack?.stop();
                user.videoTrack?.stop();
                this.remoteUsers.delete(remoteUserId);
            }
        }

        this.signal.onLeave = async (userId: JanusID): Promise<void> => {
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
        this.publishedTracks = tracks;

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
        pc.onconnectionstatechange = async () => {
            this.log.info(`publisher pc connection state changed: ${pc.connectionState}`);
            if (pc.connectionState === "failed") {
                await this.handleDisconnect();
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

        tracks.forEach((track: LocalTrack) => {
            track.on("new-track", (newMediaStreamTrack: MediaStreamTrack, oldMediaStreamTrack: MediaStreamTrack) => {
                let replaced = false;
                transceivers.forEach((t) => {
                    if (t.sender && t.sender.track && t.sender.track === oldMediaStreamTrack) {
                        t.sender.replaceTrack(newMediaStreamTrack);
                        replaced = true;
                    }
                });

                if (!replaced) {
                    this.log.error("replace track failed, no old track found in pc");
                }
            });
        });

        this.resetStats();
        this.publisherStats = new WebrtcStats(pc);
        this.publisherStats.start(2000);
        this.publisherStats.on("stats", report => {
            this.emit("stats", report);
        });
        setInterval(() => {
            this.emit("network-quality", this.getNetworkQuality());
        }, 2000);
    }

    public async unpublish(): Promise<void> {
        await this.signal.unpublish();
        this.publisherPc = undefined;
        this.publishedTracks = [];
    }

    async subscribe(userId: JanusID, track: RemoteTrack): Promise<void> {
        await this.subscribeQueue.add(() => this.doSubscribe(userId, track));
    }

    async doSubscribe(userId: JanusID, track: RemoteTrack): Promise<void> {
        this.log.info(`start subscribe (uid: ${userId}, mid: ${track.mid}, codec: ${track.codec})`);
        let subscription: Subscription;
        if (!this.subscriberPc) {
            await this.signal.attach("subscriber");
            this.subscriberPc = this.createSubscriberPC();
            subscription = await this.signal.joinSubscriber(userId, track);
        } else {
            subscription = await this.signal.subscribe(userId, track);
        }

        const p = new Promise<void>((resolve) => {
            this.innerEmitter.once("ontrack", (mediaTrack: MediaStreamTrack) => {
                track.setMediaStreamTrack(mediaTrack.clone());

                let subscribedUser = this.remoteUsers.get(userId);
                if (!subscribedUser) {
                    subscribedUser = new RemoteUserSubscribed(userId);
                    this.remoteUsers.set(userId, subscribedUser);
                }

                if (track instanceof RemoteVideoTrack) {
                    if (subscribedUser.videoTrack) {
                        subscribedUser.videoTrack.stop();
                    }
                    subscribedUser.videoTrack = track;
                } else if (track instanceof RemoteAudioTrack) {
                    if (subscribedUser.audioTrack) {
                        subscribedUser.audioTrack.stop();
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

        pc.onconnectionstatechange = () => {
            this.log.debug("subscriber connection state change", {state: pc.connectionState});
            if (pc.connectionState === "failed") {
                this.handleDisconnect();
            }
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
            event.track.onended = (ev) => {
                const uid = this.trackMap.getUser(event.transceiver.mid as string);
                this.log.debug(`${event.track.kind} track ended - true (uid: ${uid})`);
            }

            event.track.onmute = (ev) => {
                const uid = this.trackMap.getUser(event.transceiver.mid as string);
                this.log.debug(`${event.track.kind} track mute - true (uid: ${uid})`);
            }

            event.track.onunmute = (ev) => {
                const uid = this.trackMap.getUser(event.transceiver.mid as string);
                this.log.debug(`${event.track.kind} track mute - false (uid: ${uid})`);
            }

            this.innerEmitter.emit("ontrack", event.track);
        }

        return pc;
    }

    public async leave(): Promise<void> {
        this.changeConnectionState("DISCONNECTING");
        await this.signal.destroy();
        this.reset();
        this.changeConnectionState("DISCONNECTED", ConnectionDisconnectedReason.LEAVE);
    }

    public getLocalAudioTrackStats(): LocalAudioTrackStats | undefined {
        return this.publisherStats ? this.publisherStats.getLocalAudioTrackStats() : undefined;
    }

    public getKLocalVideoTrackStats(): LocalVideoTrackStats | undefined {
        return this.publisherStats ? this.publisherStats.getLocalVideoTrackStats() : undefined;
    }

    public getNetworkQuality(): NetworkQuality {
        if (!this.publisherStats) {
            return {uplink: 0, downlink: 0};
        }
        return this.publisherStats.getNetworkQuality();
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

        this.publishedTracks = [];
        this.innerEmitter.removeAllListeners();
        this.trackMap.clear();
        this.subscribeQueue = new PromiseQueue(1);
        this.reconnectAttempts = 0;
        this.reconnectStart = 0;
        this.isJoined = false;
        this.resetStats();
    }

    private resetStats(): void {
        this.publisherStats?.stop();
        if (this.networkQualityTimer) {
            clearInterval(this.networkQualityTimer);
        }
    }

    private changeConnectionState(state: ConnectionState, reason?: ConnectionDisconnectedReason): void {
        const prevState = this._connectionState;
        if (prevState !== state) {
            this._connectionState = state;
            this.log.info(`connection state: ${prevState} -> ${state}`, (reason ? `(reason: ${reason})` : ''));
            this.emit("connection-state-change", state, prevState, reason);
        }
    }
}

export interface ClientConfig {
    codec: VIDEO_CODECS;
}

export type JanusClientCallbacks = {
    "user-published": (remoteUserId: JanusID, remoteTrack: RemoteTrack) => Promise<void> | void;

    "user-unpublished": (remoteUserId: JanusID) => Promise<void> | void;

    "user-left": (remoteUserId: JanusID) => Promise<void> | void;

    "connection-state-change": (currState: ConnectionState, prevState: ConnectionState, reason?: ConnectionDisconnectedReason) => void;

    "stats": (stats: StatsResult) => void;

    "network-quality": (stats: NetworkQuality) => void;
}

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "DISCONNECTING";

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
