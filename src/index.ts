import { Logger } from "ts-log";
import {JanusClient, ClientConfig} from "./client";
import {LocalVideoTrack, LocalAudioTrack, LocalTrackConfig} from "./track";

export type JanusID = string | number;

export default class JanusSDK {

    public static createClient(config: ClientConfig, logger: Logger = console): JanusClient {
        return new JanusClient(config, logger);
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
