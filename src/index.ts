import { Logger } from "ts-log";
import {JanusClient, ClientConfig} from "./client";
import {LocalVideoTrack, LocalAudioTrack, LocalTrackConfig} from "./track";

export type JanusID = string | number;

export default class JanusSDK {

    private static logger: Logger = console;

    public static setLogger(logger: Logger): void {
        JanusSDK.logger = logger;
    }

    public static createClient(config: ClientConfig): JanusClient {
        return new JanusClient(config, JanusSDK.logger);
    }

    public static createLocalVideoTrack(track: MediaStreamTrack, config: LocalTrackConfig): LocalVideoTrack {
        return new LocalVideoTrack(track, config);
    }

    public static createLocalAudioTrack(track: MediaStreamTrack, config: LocalTrackConfig): LocalAudioTrack {
        return new LocalAudioTrack(track, config);
    }
}

export type {
    JanusClientBase,
    JanusClientCallbacks,
    JanusClient,
    ClientConfig,
    ConnectionState,
    ConnectionDisconnectedReason,
    RemoteUserSubscribed
} from "./client";

export type {
    JanusTrack,
    LocalTrack,
    LocalVideoTrack,
    LocalAudioTrack,
    LocalTrackConfig,
    RemoteTrack,
    RemoteAudioTrack,
    RemoteVideoTrack,
} from "./track";

export type {
    LocalAudioTrackStats,
    LocalVideoTrackStats,
    NetworkQuality,
    NetworkQualityLevel,
    StatsResult,

} from "./stats";

export type {
    VIDEO_CODECS,
    TrackKind
} from "./types";
