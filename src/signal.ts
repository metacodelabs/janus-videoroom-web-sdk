import {EventEmitter} from 'events';
import {JanusID} from "./index";
import {Logger} from "ts-log";
import {timeout} from "promise-timeout";
import {normalizeWebSocketUrl, randomString} from "./utils";
import {LocalTrack, RemoteAudioTrack, RemoteTrack, RemoteVideoTrack, TrackMidMap} from "./track";
import {ErrorCode, JanusError} from "./errors";

export default class SignalClient {

    private server?: string;

    private roomId?: JanusID;

    private token?: string;

    private adminKey?: string;

    private ws?: WebSocket;

    private isConnected: boolean;

    private sessionId?: number;

    private publisherId?: number;

    private subscriberId?: number;

    private userId?: JanusID;

    /**
     * a different unique ID associated to the participant; meant to be private
     * @see https://janus.conf.meetecho.com/docs/videoroom.html
     * @private
     */
    private userPrivateId?: number;

    /**
     * an optional opaque string meaningful to your application (e.g., to map all the handles of the same user);
     * @see https://janus.conf.meetecho.com/docs/JS.html
     * @private
     */
    private readonly opaqueId?: string;

    private ignoreAckRequests: Map<string, boolean> = new Map();

    private log: Logger;

    private transactionEmitter: EventEmitter;

    private readonly KEEP_ALIVE_PERIOD = 25000;

    private keepAliveTimerId?: ReturnType<typeof setTimeout>;

    public onClose?: (reason: string) => void;

    public onLeave?: (userId: JanusID) => void;

    public onUpdated?: (jsep: Jsep) => Promise<void>;

    public onPublished?: (remoteUserId: JanusID, remoteTrack: RemoteTrack) => void;

    constructor(log: Logger = console) {
        this.log = log;
        this.isConnected = false;
        this.transactionEmitter = new EventEmitter();
        this.opaqueId = randomString(16);
    }

    public connect(server: string, token?: string, adminKey?: string): Promise<void> {
        this.server = server;
        this.token = token;
        this.adminKey = adminKey;

        return new Promise((resolve, reject) => {
            this.ws = undefined;
            const serverUrl = normalizeWebSocketUrl(this.server as string);

            const ws = new WebSocket(serverUrl, "janus-protocol");

            ws.onopen = async () => {
                this.log.debug("signal server opened.");
                this.ws = ws;
                await this.createSession();
                this.isConnected = true;
                this.startKeepAliveTimer();
                resolve();
            }

            ws.onerror = async (ev: Event) => {
                if (!this.ws) {
                    reject(new JanusError(ErrorCode.WS_ERR, "signal server was not reachable"));
                    return ;
                }

                this.log.error("signal server error", ev);
            }

            ws.onmessage = async (ev: MessageEvent) => {
                this.handleMessage(ev);
            }

            ws.onclose = async (ev: CloseEvent) => {
                if (this.ws != ws || !this.isConnected) {
                    return ;
                }
                this.log.info("signal server connection closed", ev.reason);
                this.isConnected = false;
                this.stopKeepAliveTimer();
                if (this.onClose) {
                    this.onClose(ev.reason);
                }
                this.ws = undefined;
            }
        });
    }

    async existsRoom(roomId: JanusID): Promise<boolean> {
        const resp = await this.request({
            janus: "message",
            body: {
                request: 'exists',
                room: roomId,
            }
        }, "publisher");

        return !!(resp.plugindata.data.exists);
    }

    async createRoom(roomId: JanusID): Promise<void> {
        const body = {
            request: "create",
            room: roomId,
            permanent: false,
            is_private: true,
            publishers: 5,
            bitrate: 400000, // @todo
            bitrate_cap: true,
            fir_freq: 1,
            audiocodec: 'opus',
            videocodec: 'h264',
            h264_profile: '42e01f',
            // h264_profile: '42e034',
            admin_key: this.adminKey,
        };

        await this.request({
            janus: "message",
            body: body,
        }, "publisher");

        this.log.debug('janus room created');
    }

    public close():void {
        this.stopKeepAliveTimer();
        this.isConnected = false;
        if (this.ws) {
            this.ws.onclose = null;
        }
        this.ws?.close();
        this.ws = undefined;
    }

    private startKeepAliveTimer(): void {
        this.stopKeepAliveTimer();
        this.keepAliveTimerId = setInterval(async () => {

            if (!this.ws || !this.isConnected) {
                return ;
            }

            const request = { janus: "keepalive" };
            await this.request(request);

        }, this.KEEP_ALIVE_PERIOD);
    }

    private stopKeepAliveTimer(): void {
        if (this.keepAliveTimerId) {
            clearInterval(this.keepAliveTimerId);
            this.keepAliveTimerId = undefined;
        }
    }

    private handleMessage(ev: MessageEvent) {
        const payload = JSON.parse(ev.data);
        if (!payload.janus) {
            return ;
        }

        const type = payload.janus;
        const tid = payload.transaction;
        if (type === "keepalive") {
            // do nothing
        } else if (type === "ack") {
            if (this.ignoreAckRequests.has(tid)) {
                // do nothing
            } else {
                this.transactionEmitter.emit(`transaction:${tid}`);
            }
        } else if (type === "success") {
            this.transactionEmitter.emit(`transaction:${tid}`, payload);
        } else if (type === "trickle") {
            //@todo
            this.log.info(`<-- (${type})`, payload);
        } else if (type === "webrtcup") {
            this.log.info("janus pc is up");
        } else if (type === "hangup") {
            this.log.info(`<-- (${type})`, payload);
        } else if (type === "detached") {
            this.log.info(`<-- (${type})`, payload);
        } else if (type === "media") {
            this.log.debug(`janus ${payload.receiving ? "started" : "stopped"} receiving our ${payload.type}`);
        } else if (type === "slowlink") {
            this.log.info(`<-- (${type})`, payload);
        } else if (type === "error") {
            this.log.error(`<-- (${type})`, payload);
        } else if (type === "event") {
            if (tid) {
                this.transactionEmitter.emit(`transaction:${tid}`, payload);
            } else {
                let processed = false;

                const data = payload.plugindata.data;
                if (!data) {
                    this.log.error("janus event invalid.", payload);
                    return ;
                }

                if (data.videoroom === "event" && data.publishers) {
                    processed = true;
                    this.emitUserPublished(data.publishers);
                }

                if (data.videoroom === "event" && data.leaving) {
                    processed = true;
                    if (this.onLeave) {
                        this.onLeave(data.leaving);
                    }
                }

                if (data.videoroom === "updated") {
                    processed = true;
                    if (this.onUpdated) {
                        this.onUpdated(payload.jsep);
                    }
                }

                if (!processed) {
                    this.log.warn(`<-- (unprocessed event)`, payload);
                }
            }
        } else if (type === "timeout") {
            this.log.error(`<-- (${type})`, payload);
        } else {
            this.log.warn(`<-- (${type})`, payload);
        }
    }

    public async attach(type: "publisher" | "subscriber" = "publisher"): Promise<void> {
        const attached = await this.request({janus: "attach", plugin: "janus.plugin.videoroom", opaqueId: this.opaqueId});
        const handleId = attached.data.id;
        if (type === "publisher") {
            this.publisherId = handleId;
        } else {
            this.subscriberId = handleId;
        }
        this.log.debug(`video room plugin attached (${type}, id: ${handleId})`);
    }

    public async joinPublisher(roomId: JanusID, userId: JanusID): Promise<void> {
        const body = {
            request: "join",
            ptype: "publisher",
            room: roomId,
            id: userId,
        }

        const joined = await this.request({
            janus: "message",
            body: body
        }, "publisher", true);

        this.roomId = roomId;
        this.userId = userId;
        this.userPrivateId = joined.plugindata.data.private_id;

        if (joined.plugindata.data.publishers) {
            this.emitUserPublished(joined.plugindata.data.publishers);
        }
    }

    public async configureMedia(offer: RTCSessionDescriptionInit, tracks: LocalTrack[]): Promise<RTCSessionDescriptionInit> {
        const body = {
            request: "configure",
            audio: true,
            video: true,
            audiocodec: "opus",
            videocodec: "h264"
            // eslint-disable-next-line
        } as any;

        let audioBitrate = 0;
        let videoBitrate = 0;
        tracks.forEach((track: LocalTrack) => {
            if (track.isAudio() && track.bitrate) {
                audioBitrate += track.bitrate;
            } else if (track.isVideo() && track.bitrate) {
                videoBitrate += track.bitrate;
            }
        });

        if (videoBitrate > 0) {
            body.bitrate = (videoBitrate + audioBitrate) * 1000;
        }

        const configured = await this.request({
            janus: "message",
            body,
            jsep: {type: offer.type, sdp: offer.sdp},
        }, "publisher", true);

        if (!configured.jsep) {
            throw new JanusError(ErrorCode.UNEXPECTED_ERROR, "call configure failed, no jsep return");
        }

        return configured.jsep as RTCSessionDescriptionInit;
    }

    public async unpublish(): Promise<void> {
        await this.request({
            janus: "message",
            body: {
                request: "unpublish"
            },
        }, "publisher", true);
    }

    public async joinSubscriber(userId: JanusID, track: RemoteTrack): Promise<Subscription> {
        const body = {
            request: 'join',
            room: this.roomId,
            ptype: 'subscriber',
            private_id: this.userPrivateId,
            streams: [{
                feed: userId,
                mid: track.mid,
            }],
        }

        const joined = await this.request({
            janus: "message",
            body: body
        }, "subscriber", true);

        this.log.debug("subscriber joined", joined);

        const subscription = {
            jsep: joined.jsep as Jsep,
            tracksMap: []
        } as Subscription;

        for (const s of joined.plugindata.data.streams) {
            const map = {
                type: s.type,
                userId: s.feed_id,
                tmpMid: s.feed_mid,
                formalMid: s.mid,
            } as TrackMidMap;
            subscription.tracksMap.push(map);
        }

        this.log.debug("new subscriptions", subscription);

        return subscription;
    }

    async subscribe(userId: JanusID, track: RemoteTrack): Promise<Subscription> {
        const body = {
            request: "subscribe",
            streams: [{
                feed: userId,
                mid: track.mid,
            }]
        }

        const subscribed = await this.request({
            janus: "message",
            body: body
        }, "subscriber", true);

        const subscription = {
            jsep: subscribed.jsep as Jsep,
            tracksMap: []
        } as Subscription;

        for (const s of subscribed.plugindata.data.streams) {
            const map = {
                type: s.type,
                userId: s.feed_id,
                tmpMid: s.feed_mid,
                formalMid: s.mid,
            } as TrackMidMap;
            subscription.tracksMap.push(map);
        }

        this.log.debug("new subscriptions", subscription);

        return subscription;
    }

    public async unsubscribe(userId: JanusID): Promise<void> {
        const body = {
            request: "unsubscribe",
            streams: [{ feed: userId}],
        }

        await this.request({
            janus: "message",
            body: body
        }, "subscriber", true);
    }

    public async startSubscriber(jsep: RTCSessionDescriptionInit): Promise<void> {
        await this.request({
            janus: "message",
            body: {
                request: "start",
                room: this.roomId
            },
            jsep: {
                type: jsep.type,
                sdp: jsep.sdp,
            }
        }, "subscriber", true);
    }

    public async sendCandidate(candidate: RTCIceCandidate, handleType: HandleType): Promise<void> {
        await this.request({janus: "trickle", candidate: { completed: true }}, handleType);
    }

    public async sendCandidateCompleted(handleType: HandleType): Promise<void> {
        await this.request({janus: "trickle", candidate: { completed: true }}, handleType);
    }

    async destroy(): Promise<void> {
        await this.request({
            janus: "destroy",
        });

        if (this.keepAliveTimerId) {
            clearInterval(this.keepAliveTimerId);
            this.keepAliveTimerId = undefined;
        }

        this.ws?.close();
        this.ws = undefined;

        this.server = undefined;
        this.roomId = undefined;
        this.token = undefined;
        this.adminKey = undefined;
        this.isConnected = false;
        this.sessionId = undefined;
        this.publisherId = undefined;
        this.subscriberId = undefined;
        this.userId = undefined;
        this.userPrivateId = undefined;
        this.ignoreAckRequests.clear();
        this.transactionEmitter.removeAllListeners();
    }

    private async createSession(): Promise<void> {
        const created = await this.request({janus: "create"});
        this.sessionId = created.data.id as number;
        this.log.debug(`session created (id: ${this.sessionId})`);
    }

    private async request(params: any, handleType?: HandleType, ignoreAck = false, timeoutMs = 5000): Promise<any> {
        const tid = randomString(12);
        if (ignoreAck) {
            this.ignoreAckRequests.set(tid, true);
        }

        const p = new Promise((resolve, reject) => {
            params.transaction = tid;
            if (this.token) {
                params.token = this.token;
            }
            if (this.sessionId) {
                params.session_id = this.sessionId;
            }

            if (handleType) {
                params.handle_id = handleType === "publisher" ? this.publisherId : this.subscriberId;
                if (!params.handle_id) {
                    throw new JanusError(ErrorCode.UNEXPECTED_ERROR, `${handleType} handle id is not exist.`);
                }
            }

            // this.log.info(":-->", params);

            this.ws?.send(JSON.stringify(params));

            this.transactionEmitter.once(`transaction:${tid}`, (payload: any) => {
                if (payload?.plugindata?.data?.error) {
                    const data = payload.plugindata?.data;
                    reject(new JanusError(ErrorCode.SIGNAL_ERROR, `(${data.error_code}) ${data.error}`));
                }

                resolve(payload);
            });
        });

        try {
            return await timeout<any>(p, timeoutMs);
        } catch (error) {
            this.transactionEmitter.removeAllListeners(`transaction:${tid}`);
            throw error;
        }
    }

    private emitUserPublished(publishers: any[]) {
        for (const p of publishers) {
            const remoteUserId = p.id as JanusID;
            for(const t of p.streams) {
                let remoteTrack: RemoteVideoTrack | RemoteAudioTrack;
                if (t.type === "video") {
                    remoteTrack = new RemoteVideoTrack(t.mid, t.codec);
                } else {
                    remoteTrack = new RemoteAudioTrack(t.mid, t.codec);
                }
                if (this.onPublished) {
                    this.onPublished(remoteUserId, remoteTrack);
                }
            }
        }
    }
}

type HandleType = "publisher" | "subscriber";

export interface Jsep {
    type: "answer" | "offer";
    sdp: string;
}

export interface Subscription {
    jsep: Jsep;
    tracksMap: TrackMidMap[];
}
