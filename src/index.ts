import JanusClient, {ClientConfig} from "./client";
import {LocalVideoTrack, LocalAudioTrack, LocalTrackConfig} from "./track";

export type JanusID = string | number;

export default class JanusSDK {

    public static createClient(config: ClientConfig): JanusClient {
        return new JanusClient(config);
    }

    public static createLocalVideoTrack(track: MediaStreamTrack, config: LocalTrackConfig): LocalVideoTrack {
        return new LocalVideoTrack(track, config);
    }

    public static createLocalAudioTrack(track: MediaStreamTrack, config: LocalTrackConfig): LocalAudioTrack {
        return new LocalAudioTrack(track, config);
    }

}
