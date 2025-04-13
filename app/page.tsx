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
  const [countdown, setCountdown] = useState<number | null>(null);
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
    // Request camera permission early to populate device details
    const requestCameraPermission = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((track) => track.stop());
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
            setCameraError(
              "Camera access denied. Please enable camera permissions in your browser or device settings (Settings > Safari > Camera)."
            );
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
      // Check if both players are ready for countdown
      if (updatedPlayers.length === 2 && updatedPlayers.every((p) => p.ready) && gameStatus === "waiting") {
        startCountdown();
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

    return () => {
      socketRef.current?.disconnect();
    };
  }, [gameStatus]);

  // Start 5-second countdown when both players are ready
  const startCountdown = () => {
    let timeLeft = 5;
    setCountdown(timeLeft);
    const timer = setInterval(() => {
      timeLeft -= 1;
      setCountdown(timeLeft);
      if (timeLeft <= 0) {
        clearInterval(timer);
        setCountdown(null);
        setGameStatus("ready");
      }
    }, 1000);
  };

  // Toggle ready status
  // toggleReady function already declared below

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

    const attemptCameraAccess = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: selectedDeviceId } } });
        console.log("Camera stream obtained");
        videoRef.current!.srcObject = stream;
        videoRef.current!.width = 640; // PoseNet processing size
        videoRef.current!.height = 480;
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
              setCameraError(
                `Failed to play camera stream: ${err.message}. Please ensure camera permissions are allowed in Safari settings and try again.`
              );
            });
        };
      } catch (err: unknown) {
        console.error("Camera access error:", err);
        if (err instanceof DOMException) {
          if (err.name === "NotAllowedError") {
            setCameraError(
              "Camera access denied. Please enable camera permissions in Safari or device settings (Settings > Safari > Camera)."
            );
          } else if (err.name === "NotFoundError") {
            setCameraError("No camera found. Please ensure a camera is available and try again.");
          } else {
            setCameraError(`Camera error: ${err.message}. Please check your device and refresh.`);
          }
        } else {
          setCameraError(`Camera error: ${err instanceof Error ? err.message : 'Unknown error'}. Please check your device and refresh.`);
        }
      }
    };

    attemptCameraAccess();

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
      await tf.setBackend("webgl");
      await tf.ready();
      console.log("TensorFlow.js backend set to WebGL");

      // PoseNet setup
      netRef.current = await posenet.load({
        architecture: "MobileNetV1",
        outputStride: 16,
        inputResolution: { width: 640, height: 480 },
        multiplier: 0.75,
      });
      console.log("PoseNet loaded with resolution: 640x480");

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
      const radius = selectedGun === "sniper" ? 75 : selectedGun === "pistol" ? 125 : 175;
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
              damage = selectedGun === "sniper" ? 40 : 20;
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
    setCountdown(null);
    socketRef.current?.emit("resetGame");
  };

  const toggleReady = () => {
    if (socketRef.current && socketId) {
      const player = players.find((p) => p.id === socketId);
      if (player) {
        socketRef.current.emit("setReady", { playerId: socketId, ready: !player.ready });
        console.log("Toggled ready status:", !player.ready);
      }
    }
  };

  const handleGunChange = (gun: "sniper" | "pistol" | "shotgun") => {
    setSelectedGun(gun);
    console.log("Selected gun:", gun);
  };

  return (
    <div className="text-center bg-gray-900 text-white min-h-screen p-5 font-sans flex items-center justify-center">
      {gameStatus === "waiting" ? (
        <div className="w-full max-w-lg bg-gray-800 p-8 rounded-xl shadow-2xl animate-fade-in">
          <h1 className="text-5xl font-bold mb-6 text-red-500 drop-shadow-lg">AR Deathmatch</h1>
          <h2 className="text-2xl mb-4 text-gray-300">Lobby</h2>
          <div className="mb-6">
            {players.map((player) => (
              <div
                key={player.id}
                className={`flex justify-between items-center p-4 mb-2 rounded-lg shadow-md transition-transform transform hover:scale-105 ${
                  player.ready ? "bg-green-600" : "bg-red-600"
                }`}
              >
                <span className="text-lg font-semibold">
                  Player {player.id.slice(0, 4)}
                </span>
                <div className="flex items-center space-x-4">
                  <span className="text-lg">Health: {player.health}</span>
                  {player.id === socketId && (
                    <button
                      onClick={toggleReady}
                      className={`py-2 px-4 rounded-lg font-semibold transition-all transform hover:scale-110 shadow-md ${
                        player.ready
                          ? "bg-green-500 text-white"
                          : "bg-gray-500 text-gray-200 hover:bg-gray-400"
                      }`}
                    >
                      {player.ready ? "Ready" : "Not Ready"}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {players.length < 2 && (
              <p className="text-gray-400 mt-2">Waiting for opponent...</p>
            )}
          </div>
          {socketId && players.some((p) => p.id === socketId) && (
            <div className="mb-6">
              <h3 className="text-xl font-semibold mb-3 text-gray-200">Select Your Gun</h3>
              <div className="flex justify-center space-x-4">
                <button
                  onClick={() => handleGunChange("sniper")}
                  className={`py-3 px-6 rounded-lg font-bold text-lg transition-all transform hover:scale-110 shadow-md ${
                    selectedGun === "sniper"
                      ? "bg-green-500 text-white"
                      : "bg-gray-700 text-gray-300 hover:bg-green-400"
                  }`}
                >
                  Sniper
                </button>
                <button
                  onClick={() => handleGunChange("pistol")}
                  className={`py-3 px-6 rounded-lg font-bold text-lg transition-all transform hover:scale-110 shadow-md ${
                    selectedGun === "pistol"
                      ? "bg-red-500 text-white"
                      : "bg-gray-700 text-gray-300 hover:bg-red-400"
                  }`}
                >
                  Pistol
                </button>
                <button
                  onClick={() => handleGunChange("shotgun")}
                  className={`py-3 px-6 rounded-lg font-bold text-lg transition-all transform hover:scale-110 shadow-md ${
                    selectedGun === "shotgun"
                      ? "bg-yellow-500 text-white"
                      : "bg-gray-700 text-gray-300 hover:bg-yellow-400"
                  }`}
                >
                  Shotgun
                </button>
              </div>
            </div>
          )}
          <div className="p-4 rounded-lg font-bold text-lg transition-colors">
            {countdown !== null ? (
              <span className="text-3xl text-yellow-400 animate-pulse">
                Starting in {countdown}...
              </span>
            ) : players.length < 2 ? (
              <span className="bg-orange-500 p-4 rounded-lg">
                Waiting for 2 Players
              </span>
            ) : (
              <span className="bg-gray-500 p-4 rounded-lg">
                Waiting for both players to be ready...
              </span>
            )}
          </div>
        </div>
      ) : gameStatus === "ready" ? (
        <div className="relative w-full h-screen">
          {cameraError ? (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-500 text-white p-4 rounded-xl shadow-lg">
              <p>{cameraError}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 bg-white text-red-500 px-4 py-2 rounded-lg hover:bg-gray-100 transition"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                className="absolute top-0 left-0 w-full h-full object-cover"
                playsInline
                muted
              />
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[640px] h-[480px]">
                <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full" />
              </div>
              {/* Health Bars */}
              <div className="absolute top-4 left-4 right-4 flex justify-between">
                {players.map((player) => (
                  <div
                    key={player.id}
                    className="flex flex-col items-center w-1/3 bg-black/60 p-3 rounded-lg shadow-md"
                  >
                    <span className="text-lg font-bold text-white mb-1">
                      {player.id === socketId ? "You" : "Opponent"} ({player.id.slice(0, 4)})
                    </span>
                    <div className="w-full bg-gray-700 rounded-full h-4 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          player.health > 50 ? "bg-green-500" : player.health > 20 ? "bg-yellow-500" : "bg-red-500"
                        }`}
                        style={{ width: `${player.health}%` }}
                      ></div>
                    </div>
                    <span className="text-sm text-gray-300 mt-1">{player.health}/100</span>
                  </div>
                ))}
              </div>
              {/* Camera Select */}
              <select
                value={selectedDeviceId || ""}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedDeviceId(e.target.value)}
                className="absolute bottom-4 left-4 bg-gray-800 text-white p-2 rounded-lg shadow-md focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                {videoDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
                  </option>
                ))}
              </select>
              {/* Gun Display */}
              <div
                className={`absolute bottom-4 right-4 flex items-center bg-black/60 p-3 rounded-lg shadow-md ${
                  selectedGun === "sniper"
                    ? "border-2 border-green-500"
                    : selectedGun === "pistol"
                    ? "border-2 border-red-500"
                    : "border-2 border-yellow-500"
                }`}
              >
                <span
                  className={`text-lg font-bold ${
                    selectedGun === "sniper"
                      ? "text-green-400"
                      : selectedGun === "pistol"
                      ? "text-red-400"
                      : "text-yellow-400"
                  }`}
                >
                  {selectedGun.charAt(0).toUpperCase() + selectedGun.slice(1)}
                </span>
              </div>
              {/* Shoot Button */}
              <button
                onClick={handleShoot}
                className={`absolute bottom-6 left-1/2 transform -translate-x-1/2 text-white font-bold py-4 px-8 rounded-full shadow-xl transition-all ${
                  isReloading
                    ? "bg-gray-600 cursor-not-allowed"
                    : "bg-red-600 hover:bg-red-700 animate-pulse"
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