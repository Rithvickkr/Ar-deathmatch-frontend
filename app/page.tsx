"use client";

import { useEffect, useState, useRef } from "react";
import io, { Socket } from "socket.io-client";
import * as THREE from "three";
import * as tf from "@tensorflow/tfjs";
import * as posenet from "@tensorflow-models/posenet";

interface Player {
  id: string;
  health: number;
  ready: boolean;
}

export default function Game() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [gameStatus, setGameStatus] = useState<"waiting" | "ready" | "over">("waiting");
  const [socketId, setSocketId] = useState<string | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [lastShot, setLastShot] = useState<number>(0);
  const [isReloading, setIsReloading] = useState<boolean>(false);
  const socketRef = useRef<Socket | null>(null);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const sniperSoundRef = useRef<HTMLAudioElement>(null);
  const pistolSoundRef = useRef<HTMLAudioElement>(null);
  const shotgunSoundRef = useRef<HTMLAudioElement>(null);
  const hitSoundRef = useRef<HTMLAudioElement>(null);
  const netRef = useRef<posenet.PoseNet | null>(null);
  const [selectedGun, setSelectedGun] = useState<"sniper" | "pistol" | "shotgun">("pistol");

  useEffect(() => {
    // Initialize socket
    socketRef.current = io("https://ar-game-server.onrender.com", {
      reconnection: true,
      reconnectionAttempts: 5,
    });

    socketRef.current.on("connect", () => {
      console.log("Connected as:", socketRef.current!.id);
      setSocketId(socketRef.current!.id || null);
      socketRef.current!.emit("joinGame");
    });

    socketRef.current.on("playerUpdate", (updatedPlayers: Player[]) => {
      console.log("Player update received:", updatedPlayers);
      setPlayers(updatedPlayers);
      if (updatedPlayers.length === 2 && gameStatus === "waiting") {
        setGameStatus("ready");
      }
    });

    socketRef.current.on("gameOver", ({ winner }: { winner: string }) => {
      console.log("Game over, winner:", winner);
      setGameStatus("over");
      setWinner(winner);
      if (hitSoundRef.current) {
        hitSoundRef.current.play().catch((err: Error) => console.error("Hit sound error:", err));
      }
    });

    socketRef.current.on("connect_error", (err: { message: string }) => {
      console.error("Connection failed:", err.message);
    });

    // Request camera permission early to populate device details
    const requestCameraPermission = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        // Stop the stream immediately to avoid keeping the camera on
        stream.getTracks().forEach((track) => track.stop());
        // Now enumerate devices
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((device) => device.kind === "videoinput");
        console.log("Available video devices:", videoInputs);
        if (videoInputs.length === 0) {
          setCameraError("No cameras found. Please connect a camera and try again.");
          return;
        }
        setVideoDevices(videoInputs);
        setSelectedDeviceId(videoInputs[0].deviceId || null);
      } catch (err: unknown) {
        console.error("Initial camera permission error:", err);
        if (err instanceof DOMException) {
          if (err.name === "NotAllowedError") {
            setCameraError("Camera access denied. Please enable camera permissions in your browser settings.");
          } else if (err.name === "NotFoundError") {
            setCameraError("No camera found. Please ensure a camera is connected and try again.");
          } else {
            setCameraError(`Camera error: ${err.message}. Please check your device and refresh.`);
          }
        } else {
          setCameraError("Unexpected camera error. Please refresh and try again.");
        }
      }
    };

    requestCameraPermission();

    return () => {
      socketRef.current?.disconnect();
    };
  }, [gameStatus]);

  useEffect(() => {
    if (gameStatus === "waiting" || !videoRef.current || !canvasRef.current || !selectedDeviceId) {
      console.log("Not ready yet:", {
        gameStatus,
        video: !!videoRef.current,
        canvas: !!canvasRef.current,
        device: !!selectedDeviceId,
      });
      return;
    }

    console.log("Starting camera and AR with device:", selectedDeviceId);

    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((stream: MediaStream) => {
        console.log("Camera stream obtained");
        videoRef.current!.srcObject = stream;
        videoRef.current!.onloadedmetadata = () => {
          videoRef.current!
            .play()
            .then(() => {
              console.log("Video playing, dimensions:", {
                width: videoRef.current!.videoWidth,
                height: videoRef.current!.videoHeight,
              });
              initAR();
            })
            .catch((err: Error) => {
              console.error("Video play error:", err);
              setCameraError("Failed to play camera stream. Please allow camera access and try again.");
            });
        };
      })
      .catch((err: Error) => {
        console.error("Camera access error:", err);
        if (err.name === "NotAllowedError") {
          setCameraError("Camera access denied. Please enable camera permissions in your browser settings.");
        } else if (err.name === "NotFoundError") {
          setCameraError("No camera found. Please ensure a camera is connected and try again.");
        } else {
          setCameraError(`Camera error: ${err.message}. Please check your device and refresh.`);
        }
      });

    const initAR = async () => {
      console.log("Initializing AR...");
      const canvas = canvasRef.current!;

      // Three.js setup
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(75, 640 / 480, 0.1, 1000);
      camera.position.z = 1;
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
      renderer.setSize(640, 480); // Hit detection area size
      console.log("Renderer initialized with size: 640x480");

      // Improved Crosshair based on selected gun
      const crosshairGroup = new THREE.Group();
      let crosshairGeo: THREE.RingGeometry;
      let crosshairMat: THREE.MeshBasicMaterial;
      if (selectedGun === "sniper") {
        crosshairGeo = new THREE.RingGeometry(0.01, 0.02, 32);
        crosshairMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
      } else if (selectedGun === "pistol") {
        crosshairGeo = new THREE.RingGeometry(0.02, 0.04, 32);
        crosshairMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      } else {
        // Shotgun
        crosshairGeo = new THREE.RingGeometry(0.05, 0.08, 32);
        crosshairMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
      }
      const crosshair = new THREE.Mesh(crosshairGeo, crosshairMat);
      crosshair.position.set(0, 0, -0.5);
      crosshairGroup.add(crosshair);

      // Add crosshair lines
      const lineMat = new THREE.LineBasicMaterial({ color: crosshairMat.color });
      const lineGeoH = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.1, 0, -0.5),
        new THREE.Vector3(0.1, 0, -0.5),
      ]);
      const lineGeoV = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -0.1, -0.5),
        new THREE.Vector3(0, 0.1, -0.5),
      ]);
      crosshairGroup.add(new THREE.Line(lineGeoH, lineMat));
      crosshairGroup.add(new THREE.Line(lineGeoV, lineMat));

      scene.add(crosshairGroup);
      console.log("Crosshair added for", selectedGun);

      // TensorFlow.js backend
      await tf.setBackend("webgl").catch((err: Error) => {
        console.error("WebGL backend error:", err);
        setCameraError("Failed to initialize WebGL for PoseNet. Please try a different browser or device.");
      });
      await tf.ready();
      console.log("TensorFlow.js backend set to WebGL");

      // PoseNet setup
      try {
        netRef.current = await posenet.load({
          architecture: "MobileNetV1",
          outputStride: 16,
          inputResolution: { width: 640, height: 480 },
          multiplier: 0.75,
        });
        console.log("PoseNet loaded with resolution: 640x480");
      } catch (err: unknown) {
        console.error("PoseNet load error:", err);
        setCameraError("Failed to load PoseNet model. Please refresh and try again.");
      }

      const animate = () => {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
      };
      animate();
      console.log("Animation started");
    };
  }, [gameStatus, selectedDeviceId, selectedGun]);

  const handleShoot = async () => {
    console.log("Shoot button pressed");
    if (!socketRef.current || !netRef.current || !videoRef.current || isReloading) {
      console.log("Missing required refs or reloading:", {
        socket: !!socketRef.current,
        net: !!netRef.current,
        video: !!videoRef.current,
        isReloading,
      });
      return;
    }

    const now = Date.now();
    // Cooldowns per gun
    const cooldownTime = selectedGun === "pistol" ? 200 : selectedGun === "sniper" ? 400 : 600; // Pistol: 200ms, Sniper: 400ms, Shotgun: 600ms
    if (now - lastShot < cooldownTime) {
      console.log("Cooldown active, skipping shot");
      return;
    }

    // Play sound immediately on button press
    if (selectedGun === "sniper" && sniperSoundRef.current) {
      sniperSoundRef.current.currentTime = 0; // Reset to start
      sniperSoundRef.current.play().catch((err: Error) => console.error("Sniper shot sound error:", err));
    } else if (selectedGun === "pistol" && pistolSoundRef.current) {
      pistolSoundRef.current.currentTime = 0; // Reset to start
      pistolSoundRef.current.play().catch((err: Error) => console.error("Pistol shot sound error:", err));
    } else if (selectedGun === "shotgun" && shotgunSoundRef.current) {
      shotgunSoundRef.current.currentTime = 0; // Reset to start
      shotgunSoundRef.current.play().catch((err: Error) => console.error("Shotgun shot sound error:", err));
    }

    setIsReloading(true);
    setLastShot(now);
    console.log("Cooldown passed, processing shot");

    try {
      const video = videoRef.current;
      console.log("Video readyState:", video.readyState, "CurrentTime:", video.currentTime);
      if (video.readyState < 4) {
        console.log("Video not fully loaded, waiting...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const poses = await netRef.current.estimateSinglePose(video, {
        flipHorizontal: true,
      });
      console.log("Poses detected:", poses);

      const headParts = ["nose", "leftEye", "rightEye", "leftEar", "rightEar"];
      const torsoParts = ["leftShoulder", "rightShoulder", "leftHip", "rightHip"];
      const lowerBodyParts = ["leftHip", "rightHip"];
      const centerX = 320; // Center of 640x480 hit detection area
      const centerY = 240;
      const radius = selectedGun === "sniper" ? 100 : selectedGun === "pistol" ? 200 : 400;
      const scaleX = 1; // No scaling, use raw PoseNet coords
      const scaleY = 1;
      const threshold = 0.5;

      console.log("Hit detection center:", { centerX, centerY }, "Radius:", radius);

      // Log all keypoints for debugging
      console.log(
        "All keypoints:",
        poses.keypoints.map((k: posenet.Keypoint) => ({
          part: k.part,
          x: k.position.x,
          y: k.position.y,
          score: k.score,
        }))
      );

      // Calculate collective scores
      const headKeypoints = headParts
        .map((part) => poses.keypoints.find((k: posenet.Keypoint) => k.part === part))
        .filter((k): k is posenet.Keypoint => k !== undefined && k.score > 0.3);
      const headScore = headKeypoints.length
        ? headKeypoints.reduce((sum: number, k: posenet.Keypoint) => sum + k.score, 0) / headKeypoints.length
        : 0;
      console.log("Head keypoints:", headKeypoints, "Collective head score:", headScore);

      const torsoKeypoints = torsoParts
        .map((part) => poses.keypoints.find((k: posenet.Keypoint) => k.part === part))
        .filter((k): k is posenet.Keypoint => k !== undefined && k.score > 0.3);
      const torsoScore = torsoKeypoints.length
        ? torsoKeypoints.reduce((sum: number, k: posenet.Keypoint) => sum + k.score, 0) / torsoKeypoints.length
        : 0;
      console.log("Torso keypoints:", torsoKeypoints, "Collective torso score:", torsoScore);

      const lowerBodyKeypoints = lowerBodyParts
        .map((part) => poses.keypoints.find((k: posenet.Keypoint) => k.part === part))
        .filter((k): k is posenet.Keypoint => k !== undefined && k.score > 0.3);
      const lowerBodyScore = lowerBodyKeypoints.length
        ? lowerBodyKeypoints.reduce((sum: number, k: posenet.Keypoint) => sum + k.score, 0) / lowerBodyKeypoints.length
        : 0;
      console.log("Lower body keypoints:", lowerBodyKeypoints, "Collective lower body score:", lowerBodyScore);

      // Define vertical zones based on 480px height
      const headZoneMax = 480 * 0.5; // 240px (50% of 480) to cover face
      const torsoZoneMin = headZoneMax;
      const torsoZoneMax = 480 * 0.85; // 408px (85% of 480) for torso
      console.log("Zones:", { headZoneMax, torsoZoneMin, torsoZoneMax, videoHeight: 480 });

      // Check for hits within crosshair radius and determine highest score
      let hitDetected = false;
      let damage = 0;
      let bestScore = 0;
      let hitType = "";

      // Check all keypoints within radius
      const allKeypoints = [...headKeypoints, ...torsoKeypoints, ...lowerBodyKeypoints];
      for (const keypoint of allKeypoints) {
        const adjustedX = keypoint.position.x * scaleX;
        const adjustedY = keypoint.position.y * scaleY;
        console.log(`${keypoint.part} position:`, { x: adjustedX, y: adjustedY, score: keypoint.score });
        const distance = Math.sqrt(Math.pow(adjustedX - centerX, 2) + Math.pow(adjustedY - centerY, 2));
        console.log(`${keypoint.part} distance from center:`, distance);

        if (distance < radius) {
          if (headParts.includes(keypoint.part) && adjustedY < headZoneMax && headScore > threshold) {
            if (headScore > bestScore) {
              bestScore = headScore;
              damage = 20;
              hitType = "Headshot";
              console.log(`Potential ${hitType} with score: ${headScore}`);
            }
          } else if (
            torsoParts.includes(keypoint.part) &&
            adjustedY >= torsoZoneMin &&
            adjustedY < torsoZoneMax &&
            torsoScore > threshold
          ) {
            if (torsoScore > bestScore) {
              bestScore = torsoScore;
              damage = 15;
              hitType = "Torso shot";
              console.log(`Potential ${hitType} with score: ${torsoScore}`);
            }
          } else if (
            lowerBodyParts.includes(keypoint.part) &&
            adjustedY >= torsoZoneMax &&
            lowerBodyScore > threshold
          ) {
            if (lowerBodyScore > bestScore) {
              bestScore = lowerBodyScore;
              damage = 10;
              hitType = "Lower body shot";
              console.log(`Potential ${hitType} with score: ${lowerBodyScore}`);
            }
          }
          hitDetected = true;
        }
      }

      if (hitDetected) {
        console.log(`${hitType} confirmed with best score: ${bestScore}, Damage set to: ${damage}`);
        console.log("Final hit detected with damage:", damage);
        socketRef.current.emit("shoot", { shooterId: socketId, damage });
        console.log("Shoot event emitted");
        // Play gun sound again on confirmed hit
        if (selectedGun === "sniper" && sniperSoundRef.current) {
          sniperSoundRef.current.currentTime = 0; // Reset to start
          sniperSoundRef.current.play().catch((err: Error) => console.error("Sniper hit sound error:", err));
        } else if (selectedGun === "pistol" && pistolSoundRef.current) {
          pistolSoundRef.current.currentTime = 0; // Reset to start
          pistolSoundRef.current.play().catch((err: Error) => console.error("Pistol hit sound error:", err));
        } else if (selectedGun === "shotgun" && shotgunSoundRef.current) {
          shotgunSoundRef.current.currentTime = 0; // Reset to start
          shotgunSoundRef.current.play().catch((err: Error) => console.error("Shotgun hit sound error:", err));
        }
      } else {
        console.log("No head, torso, or lower body detected within crosshair radius with sufficient collective score");
      }
    } catch (err: unknown) {
      console.error("PoseNet error:", err instanceof Error ? err.message : err);
    } finally {
      // Reset reloading after cooldown
      setTimeout(() => setIsReloading(false), cooldownTime);
    }
  };

  const handleReset = () => {
    console.log("Resetting game...");
    setGameStatus("waiting");
    setWinner(null);
    socketRef.current?.emit("resetGame");
  };

  const handleGunChange = (gun: "sniper" | "pistol" | "shotgun") => {
    setSelectedGun(gun);
    console.log("Selected gun:", gun);
  };

  return (
    <div className="text-center bg-gray-900 text-white min-h-screen p-5 font-sans">
      {gameStatus === "waiting" ? (
        <div className="max-w-md mx-auto bg-gray-800 p-6 rounded-lg shadow-lg">
          <h1 className="text-4xl mb-5">AR Deathmatch</h1>
          <h2 className="text-2xl mb-4">Lobby</h2>
          <div className="mb-5">
            {players.map((player) => (
              <div
                key={player.id}
                className={`p-3 ${player.ready ? "bg-green-500" : "bg-red-500"} my-2 rounded flex justify-between`}
              >
                <span>Player {player.id.slice(0, 4)}</span>
                <span>Health: {player.health}</span>
              </div>
            ))}
            {players.length < 2 && <p className="text-gray-400">Waiting for opponent...</p>}
          </div>
          <div
            className={`p-3 ${players.length === 2 ? "bg-green-500" : "bg-orange-500"} rounded font-bold`}
          >
            {players.length < 2 ? "Waiting for 2 Players" : "Game Ready!"}
          </div>
        </div>
      ) : gameStatus === "ready" ? (
        <div className="relative w-full h-screen">
          {cameraError ? (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-500 text-white p-4 rounded">
              <p>{cameraError}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 bg-white text-red-500 px-4 py-2 rounded"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="absolute top-0 left-0 w-full h-full object-cover" />
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[640px] h-[480px]">
                <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full" />
              </div>
              <div className="absolute top-2 left-2 right-2 flex justify-between text-white font-bold bg-black/50 p-2">
                {players.map((player) => (
                  <div key={player.id}>
                    {player.id === socketId ? "You" : "Opponent"}: {player.health}
                  </div>
                ))}
              </div>
              <select
                value={selectedDeviceId || ""}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedDeviceId(e.target.value)}
                className="absolute top-10 left-2 bg-gray-700 text-white p-2 rounded"
              >
                {videoDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
                  </option>
                ))}
              </select>
              <div className="absolute top-10 right-2 flex space-x-2">
                <button
                  onClick={() => handleGunChange("sniper")}
                  className={`py-2 px-4 rounded ${
                    selectedGun === "sniper" ? "bg-green-500" : "bg-gray-700"
                  } text-white`}
                >
                  Sniper
                </button>
                <button
                  onClick={() => handleGunChange("pistol")}
                  className={`py-2 px-4 rounded ${
                    selectedGun === "pistol" ? "bg-red-500" : "bg-gray-700"
                  } text-white`}
                >
                  Pistol
                </button>
                <button
                  onClick={() => handleGunChange("shotgun")}
                  className={`py-2 px-4 rounded ${
                    selectedGun === "shotgun" ? "bg-yellow-500" : "bg-gray-700"
                  } text-white`}
                >
                  Shotgun
                </button>
              </div>
              <button
                onClick={handleShoot}
                className={`absolute bottom-10 left-1/2 transform -translate-x-1/2 text-white font-bold py-3 px-6 rounded-full shadow-lg ${
                  isReloading ? "bg-gray-500 cursor-not-allowed" : "bg-red-500 hover:bg-red-600"
                }`}
                disabled={isReloading}
              >
                {isReloading ? "Reloading..." : "Shoot"}
              </button>
              <audio ref={sniperSoundRef} src="/sniper.mp3" preload="auto" />
              <audio ref={pistolSoundRef} src="/pistol.mp3" preload="auto" />
              <audio ref={shotgunSoundRef} src="/shotgun.mp3" preload="auto" />
              <audio ref={hitSoundRef} src="/hit.mp3" preload="auto" />
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
          <h1 className="text-5xl mb-5">Game Over!</h1>
          <p className="text-2xl mb-5">Winner: {winner === socketId ? "You" : "Opponent"}</p>
          <button
            onClick={handleReset}
            className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-6 rounded-full shadow-lg"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}