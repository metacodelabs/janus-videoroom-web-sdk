import {EventEmitter} from "events";
import TypedEventEmitter from "typed-emitter";

/**
 * @see https://www.w3.org/TR/webrtc-stats/
 */
export default class WebrtcStats extends (EventEmitter as new () => TypedEventEmitter<PCStatsCallbacks>) {

    private readonly pc: RTCPeerConnection;

    private timerId?: ReturnType<typeof setTimeout>;

    private prevVideoStats: Map<string, LocalVideoTrackStats>;

    private prevAudioStats: Map<string, LocalAudioTrackStats>;

    private latestStats?: StatsResult;

    constructor(pc: RTCPeerConnection) {
        super();
        this.pc = pc;
        this.prevVideoStats = new Map();
        this.prevAudioStats = new Map();
    }

    public start(interval: number): void {
        this.stop();
        this.stats().then(() => {
            this.loop(interval);
        });
    }

    public stop(): void {
        if (this.timerId) {
            clearTimeout(this.timerId);
        }
        this.prevAudioStats.clear();
        this.prevVideoStats.clear();
    }

    private async stats(): Promise<void> {
        const sources = new Map<string, any>();
        const outbounds = new Map<string, any>();
        const inbounds = new Map<string, any>();

        const report = await this.pc.getStats();

        report.forEach(item => {
            const tp = item.type;
            if (tp === "media-source") {
                sources.set(item.id, item);
            } else if (tp === "outbound-rtp") {
                outbounds.set(item.id, item);
            } else if (tp === "remote-inbound-rtp") {
                inbounds.set(item.id, item);
            }
        });

        const result = {
            videos: [],
            audios: [],
        } as StatsResult;

        sources.forEach(source => {
            let outbound: any;
            outbounds.forEach(ob => {
                if (ob.mediaSourceId === source.id) {
                    outbound = ob;
                }
            });

            let inbound: any;
            inbounds.forEach(ib => {
                if (ib.localId === outbound.id) {
                    inbound = ib;
                }
            });

            const currTs = source.timestamp;

            if (source.kind === "video") {
                const prevStats = this.prevVideoStats.get(source.trackIdentifier);

                let sendBitrate = 0;
                let sendFrameRate = 0;
                let sendPacketsLostRate = 0;
                if (prevStats) {
                    const td = (currTs - prevStats.timestamp) / 1000;

                    sendFrameRate = ((outbound?.framesSent ?? 0) - prevStats.sendFrames) / td;

                    sendBitrate = ((outbound?.bytesSent ?? 0) - prevStats.sendBytes) * 8 / td;
                    const totalPacketsSend = (outbound?.packetsSent ?? 0) - prevStats.sendPackets;
                    const totalPacketsLost = (inbound?.packetsLost ?? 0) - prevStats.sendPacketsLost;

                    if (totalPacketsSend <= 0 || (totalPacketsSend + totalPacketsLost <= 0)) {
                        sendPacketsLostRate = 0;
                    } else {
                        sendPacketsLostRate = 100 * totalPacketsLost / (totalPacketsSend + totalPacketsLost) / td;
                    }
                }

                const stats = {
                    id: source.trackIdentifier,
                    timestamp: source.timestamp,
                    captureFrameRate: source?.framesPerSecond,
                    captureFrameWidth: source?.width ?? 0,
                    captureFrameHeight: source?.height ?? 0,
                    encodeFrameRate: outbound?.framesPerSecond ?? 0,
                    encodeFrameWidth: outbound?.frameWidth ?? 0,
                    encodeFrameHeight: outbound?.frameHeight ?? 0,
                    sendFrames: outbound?.framesSent ?? 0,
                    sendFrameRate: sendFrameRate > 0 ? sendFrameRate : 0,
                    sendBytes: outbound?.bytesSent ?? 0,
                    sendBitrate: sendBitrate > 0 ? sendBitrate : 0,
                    sendPackets: outbound?.packetsSent ?? 0,
                    sendPacketsLost: inbound?.packetsLost ?? 0,
                    sendPacketsLostRate: sendPacketsLostRate,
                    rtt: inbound?.roundTripTime ?? 0,
                } as LocalVideoTrackStats;

                this.prevVideoStats.set(stats.id, stats);
                result.videos.push(stats);

            } else if (source.kind === "audio") {
                const prevStats = this.prevAudioStats.get(source.trackIdentifier);
                let sendBitrate = 0;
                let sendPacketsLostRate = 0;
                if (prevStats) {
                    const td = (currTs - prevStats.timestamp) / 1000;

                    sendBitrate = ((outbound?.bytesSent ?? 0) - prevStats.sendBytes) * 8 / td;

                    const totalPacketsSend = (outbound?.packetsSent ?? 0) - prevStats.sendPackets;
                    const totalPacketsLost = (inbound?.packetsLost ?? 0) - prevStats.sendPacketsLost;
                    if (totalPacketsSend <= 0 || (totalPacketsSend + totalPacketsLost <= 0)) {
                        sendPacketsLostRate = 0;
                    } else {
                        sendPacketsLostRate = 100 * totalPacketsLost / (totalPacketsSend + totalPacketsLost) / td;
                    }
                }

                const stats = {
                    id: source.trackIdentifier,
                    timestamp: source.timestamp,
                    sendBytes: outbound?.bytesSent ?? 0,
                    sendBitrate: sendBitrate > 0 ? sendBitrate : 0,
                    sendPackets: outbound?.packetsSent ?? 0,
                    sendPacketsLost: inbound?.packetsLost ?? 0,
                    sendPacketsLostRate: sendPacketsLostRate,
                    rtt: inbound?.roundTripTime ?? 0,
                } as LocalAudioTrackStats;

                this.prevAudioStats.set(stats.id, stats);
                result.audios.push(stats);
            }

        });

        this.latestStats = result;
        this.emit("stats", result);
    }

    public getLocalAudioTrackStats(): LocalAudioTrackStats | undefined {
        return this.latestStats && this.latestStats.audios.length > 0 ? this.latestStats.audios[0] : undefined;
    }

    public getLocalVideoTrackStats(): LocalVideoTrackStats | undefined {
        return this.latestStats && this.latestStats.videos.length > 0 ? this.latestStats.videos[0] : undefined;
    }

    /**
     * @todo downlink quality
     */
    public getNetworkQuality(): NetworkQuality {
        if (!navigator.onLine) {
            return {uplink: 5, downlink: 5};
        }

        const audioStats = this.latestStats?.audios[0];
        const videoStats = this.latestStats?.videos[0];

        if (!audioStats && !videoStats) {
            return {uplink: 0, downlink: 0};
        }

        const plr = Math.max(audioStats?.sendPacketsLostRate ?? 0, videoStats?.sendPacketsLostRate ?? 0);
        const rtt = Math.max(audioStats?.rtt ?? 0, videoStats?.rtt ?? 0);

        let uplink: NetworkQualityLevel;
        if (plr > 9 || rtt > 100) {
            uplink = 4;
        } else if (plr > 5 || rtt > 80) {
            uplink = 3;
        } else if (plr > 1 || rtt > 40) {
            uplink = 2;
        } else {
            uplink = 1;
        }

        return {uplink: uplink, downlink: 0};
    }

    private loop(interval: number): void {
        this.timerId = setTimeout(async  () => {
            await this.stats();
            this.loop(interval);
        }, interval);
    }
}

export type PCStatsCallbacks = {
    "stats": (stats: StatsResult) => Promise<void> | void;
}

export interface StatsResult {
    audios: LocalAudioTrackStats[];
    videos: LocalVideoTrackStats[];
}

export interface LocalVideoTrackStats {
    id: string;

    timestamp: number;

    captureFrameRate?: number;

    captureFrameWidth: number;

    captureFrameHeight: number;

    encodeFrameRate: number;

    encodeFrameWidth: number;

    encodeFrameHeight: number;

    sendFrames: number;

    sendFrameRate: number;

    sendBytes: number;

    sendBitrate: number;

    sendPackets: number;

    sendPacketsLost: number;

    sendPacketsLostRate: number;

    rtt: number;
}

export interface LocalAudioTrackStats {
    id: string;

    timestamp: number;

    sendBytes: number;

    sendBitrate: number;

    sendPackets: number;

    sendPacketsLost: number;

    sendPacketsLostRate: number;

    rtt: number;
}

export interface NetworkQuality {
    uplink: NetworkQualityLevel;
    downlink: NetworkQualityLevel;
}

export type NetworkQualityLevel = 0 | 1 | 2 | 3 | 4 | 5;
