declare module "@ar-js-org/ar.js" {
    export const ARjs: {
        Context: new (options: {
            cameraParametersUrl: string;
            detectionMode: string;
        }) => {
            update(video: HTMLVideoElement): void;
        };
    };
}