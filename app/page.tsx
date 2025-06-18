"use client";
import React from "react";
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
      // Set renderer size based on screen resolution
      
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
      crosshair.position.set(0, 0, -0.5); // Centered at origin (0,0) which is the center of the renderer
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
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;
      const useLowRes = screenWidth < 640 || screenHeight < 480;
      netRef.current = await posenet.load({
        architecture: "MobileNetV1",
        outputStride: 16,
        inputResolution: { width: 640, height: 420 },
        multiplier: 0.75,
      });
      console.log(`PoseNet loaded with resolution: 640x480, Low Res: ${useLowRes}`);

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
    <div className="min-h-screen bg-black text-white font-mono overflow-hidden relative">
      <style jsx>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&display=swap');
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { transform: translateY(100px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes slideDown {
          from { transform: translateY(-100px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes slideLeft {
          from { transform: translateX(-100px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideRight {
          from { transform: translateX(100px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(0.98); }
        }
        @keyframes glow {
          0%, 100% { text-shadow: 0 0 20px currentColor; }
          50% { text-shadow: 0 0 30px currentColor, 0 0 40px currentColor; }
        }
        @keyframes countdownPulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.2); opacity: 0.8; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes digitalGlitch {
          0% { transform: translate(0); }
          10% { transform: translate(-2px, 2px); }
          20% { transform: translate(-2px, -2px); }
          30% { transform: translate(2px, 2px); }
          40% { transform: translate(2px, -2px); }
          50% { transform: translate(-2px, 2px); }
          60% { transform: translate(-2px, -2px); }
          70% { transform: translate(2px, 2px); }
          80% { transform: translate(-2px, -2px); }
          90% { transform: translate(2px, 2px); }
          100% { transform: translate(0); }
        }
        @keyframes breathing {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        
        .animate-fadeIn { animation: fadeIn 0.8s ease-out forwards; }
        .animate-slideUp { animation: slideUp 0.6s ease-out forwards; }
        .animate-slideDown { animation: slideDown 0.6s ease-out forwards; }
        .animate-slideLeft { animation: slideLeft 0.6s ease-out forwards; }
        .animate-slideRight { animation: slideRight 0.6s ease-out forwards; }
        .animate-pulse { animation: pulse 2s infinite; }
        .animate-glow { animation: glow 2s infinite; }
        .animate-countdownPulse { animation: countdownPulse 1s infinite; }
        .animate-glitch { animation: digitalGlitch 0.3s ease-in-out; }
        .animate-breathing { animation: breathing 3s ease-in-out infinite; }
        
        .font-orbitron { font-family: 'Orbitron', monospace; }
        
        .tactical-overlay {
          background: linear-gradient(135deg, rgba(0, 50, 0, 0.1) 0%, rgba(0, 100, 0, 0.05) 100%);
          border: 1px solid rgba(0, 255, 0, 0.2);
          backdrop-filter: blur(10px);
          box-shadow: 
            inset 0 0 20px rgba(0, 255, 0, 0.1),
            0 0 20px rgba(0, 255, 0, 0.2);
        }
        
        .tactical-overlay-red {
          background: linear-gradient(135deg, rgba(50, 0, 0, 0.1) 0%, rgba(100, 0, 0, 0.05) 100%);
          border: 1px solid rgba(255, 0, 0, 0.2);
          backdrop-filter: blur(10px);
          box-shadow: 
            inset 0 0 20px rgba(255, 0, 0, 0.1),
            0 0 20px rgba(255, 0, 0, 0.2);
        }
        
        .tactical-overlay-blue {
          background: linear-gradient(135deg, rgba(0, 0, 50, 0.1) 0%, rgba(0, 0, 100, 0.05) 100%);
          border: 1px solid rgba(0, 100, 255, 0.2);
          backdrop-filter: blur(10px);
          box-shadow: 
            inset 0 0 20px rgba(0, 100, 255, 0.1),
            0 0 20px rgba(0, 100, 255, 0.2);
        }
        
        .tactical-overlay-yellow {
          background: linear-gradient(135deg, rgba(50, 50, 0, 0.1) 0%, rgba(100, 100, 0, 0.05) 100%);
          border: 1px solid rgba(255, 255, 0, 0.2);
          backdrop-filter: blur(10px);
          box-shadow: 
            inset 0 0 20px rgba(255, 255, 0, 0.1),
            0 0 20px rgba(255, 255, 0, 0.2);
        }
        
        .neon-text {
          text-shadow: 
            0 0 5px currentColor,
            0 0 10px currentColor,
            0 0 20px currentColor;
        }
        
        .hud-corner::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 20px;
          height: 20px;
          border-top: 2px solid currentColor;
          border-left: 2px solid currentColor;
        }
        
        .hud-corner::after {
          content: '';
          position: absolute;
          bottom: 0;
          right: 0;
          width: 20px;
          height: 20px;
          border-bottom: 2px solid currentColor;
          border-right: 2px solid currentColor;
        }
        
        .digital-border {
          position: relative;
          border: 2px solid transparent;
          background: linear-gradient(45deg, transparent, rgba(0, 255, 0, 0.1), transparent) padding-box,
                      linear-gradient(45deg, #00ff00, #ffffff, #00ff00) border-box;
        }
        
        .digital-border::before {
          content: '';
          position: absolute;
          top: -2px;
          left: -2px;
          right: -2px;
          bottom: -2px;
          background: linear-gradient(45deg, #00ff00, #ffffff, #00ff00);
          border-radius: inherit;
          z-index: -1;
          opacity: 0.3;
        }
        
        .ammo-counter {
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.1em;
        }
        
        .health-bar {
          position: relative;
          overflow: hidden;
        }

        /* Mobile HUD Optimizations */
        @media (max-width: 768px) {
          .hud-corner::before,
          .hud-corner::after {
            width: 10px;
            height: 10px;
          }
        }
          letter-spacing: 0.1em;
        }
        
        .health-bar {
          position: relative;
          overflow: hidden;
        }
        
        .health-bar::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.1) 50%, transparent 100%);
          animation: scanline 3s linear infinite;
        }

        /* Mobile HUD Optimizations */
        @media (max-width: 768px) {
          .hud-corner::before,
          .hud-corner::after {
            width: 10px;
            height: 10px;
          }
        }
      `}</style>

      {/* Scanline Effect */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute w-full h-0.5 bg-gradient-to-r from-transparent via-green-400 to-transparent opacity-30 animate-scanline"></div>
      </div>

      {gameStatus === "waiting" ? (
        <div className="flex items-center justify-center min-h-screen p-2 sm:p-4 lg:p-8">
          <div className="w-full max-w-4xl animate-fadeIn">
            {/* Main Title */}
            <div className="text-center mb-8 sm:mb-12">
              <h1 className="font-orbitron text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-green-400 mb-2 sm:mb-4 neon-text animate-glow">
                AR WARFARE
              </h1>
              <div className="text-base sm:text-xl md:text-2xl font-orbitron text-gray-400 tracking-widest mb-2">
                TACTICAL ENGAGEMENT SYSTEM
              </div>
              <div className="w-full h-px bg-gradient-to-r from-transparent via-green-400 to-transparent opacity-50"></div>
              <div className="text-xs sm:text-sm text-green-400 mt-2 font-orbitron">
                [ CLASSIFIED OPERATION ]
              </div>
            </div>

            {/* Mission Briefing Panel */}
            <div className="tactical-overlay rounded-lg p-4 sm:p-6 lg:p-8 mb-6 sm:mb-8 animate-slideUp hud-corner relative">
              <div className="scanline"></div>
              <h2 className="font-orbitron text-lg sm:text-xl lg:text-2xl font-bold text-green-400 mb-4 sm:mb-6 flex items-center">
                <span className="w-2 h-2 sm:w-3 sm:h-3 bg-green-400 rounded-full mr-2 sm:mr-3 animate-pulse"></span>
                MISSION BRIEFING
              </h2>
              
              {/* Operator Status */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6 sm:mb-8">
                {players.map((player, index) => (
                  <div
                    key={player.id}
                    className={`${player.ready ? 'tactical-overlay' : 'tactical-overlay-red'} rounded-lg p-4 sm:p-6 animate-slideLeft relative hud-corner`}
                    style={{ animationDelay: `${index * 0.2}s` }}
                  >
                    <div className="flex justify-between items-start mb-3 sm:mb-4">
                      <div>
                        <div className="font-orbitron text-sm sm:text-base lg:text-lg font-bold text-green-400">
                          {player.id === socketId ? "OPERATOR-01" : "OPERATOR-02"}
                        </div>
                        <div className="text-xs text-gray-400 font-orbitron">
                          ID: {player.id.slice(0, 8).toUpperCase()}
                        </div>
                      </div>
                      <div className={`w-3 h-3 sm:w-4 sm:h-4 rounded-full ${player.ready ? 'bg-green-400 animate-pulse' : 'bg-red-500'} border-2 border-current`}></div>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs sm:text-sm">
                        <span className="text-gray-400">STATUS:</span>
                        <span className={`font-orbitron font-bold ${player.ready ? 'text-green-400' : 'text-red-400'}`}>
                          {player.ready ? 'READY' : 'STANDBY'}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs sm:text-sm">
                        <span className="text-gray-400">HEALTH:</span>
                        <span className="text-green-400 font-orbitron font-bold">{player.health}%</span>
                      </div>
                    </div>
                    
                    {player.id === socketId && (
                      <button
                        onClick={toggleReady}
                        className={`w-full mt-3 sm:mt-4 py-2 sm:py-3 px-3 sm:px-4 rounded-lg font-orbitron font-bold text-xs sm:text-sm transition-all duration-300 transform hover:scale-105 ${
                          player.ready
                            ? "bg-green-600/20 border-2 border-green-400 text-green-400 hover:bg-green-600/30"
                            : "bg-red-600/20 border-2 border-red-400 text-red-400 hover:bg-red-600/30"
                        }`}
                      >
                        {player.ready ? "█ READY FOR COMBAT" : "◌ ENTER READY STATE"}
                      </button>
                    )}
                  </div>
                ))}
                {players.length < 2 && (
                  <div className="tactical-overlay-yellow rounded-lg p-4 sm:p-6 opacity-60 animate-pulse hud-corner relative">
                    <div className="font-orbitron text-sm sm:text-base lg:text-lg font-bold text-yellow-400 mb-2">
                      OPERATOR-02
                    </div>
                    <div className="text-xs text-gray-400 mb-3 sm:mb-4">
                      AWAITING CONNECTION...
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 sm:w-4 sm:h-4 border-2 border-yellow-400 rounded-full animate-pulse"></div>
                      <span className="text-yellow-400 font-orbitron text-xs sm:text-sm">CONNECTING</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Weapon Selection */}
              {socketId && players.some((p) => p.id === socketId) && (
                <div className="mb-6 sm:mb-8">
                  <h3 className="font-orbitron text-base sm:text-lg lg:text-xl font-bold text-green-400 mb-3 sm:mb-4 flex items-center">
                    <span className="w-2 h-2 sm:w-3 sm:h-3 bg-green-400 rounded-full mr-2 sm:mr-3"></span>
                    WEAPON SELECTION
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                    {[
                      { type: "sniper", name: "SNIPER RIFLE", damage: "HIGH", range: "LONG", color: "green", symbol: "◊" },
                      { type: "pistol", name: "TACTICAL PISTOL", damage: "MEDIUM", range: "CLOSE", color: "red", symbol: "●" },
                      { type: "shotgun", name: "COMBAT SHOTGUN", damage: "EXTREME", range: "CLOSE", color: "yellow", symbol: "◈" }
                    ].map(({ type, name, damage, range, color, symbol }) => (
                      <button
                        key={type}
                        onClick={() => handleGunChange(type as "sniper" | "pistol" | "shotgun")}
                        className={`tactical-overlay${selectedGun === type ? '' : '-' + color} rounded-lg p-3 sm:p-4 font-orbitron transition-all duration-300 transform hover:scale-105 ${
                          selectedGun === type ? 'ring-2 ring-green-400' : ''
                        } hud-corner relative`}
                      >
                        <div className={`text-xl sm:text-2xl mb-1 sm:mb-2 text-${color}-400`}>{symbol}</div>
                        <div className={`text-xs sm:text-sm font-bold text-${color}-400 mb-1`}>{name}</div>
                        <div className="text-xs text-gray-400 space-y-1">
                          <div>DMG: {damage}</div>
                          <div>RNG: {range}</div>
                        </div>
                        {selectedGun === type && (
                          <div className="absolute top-1 right-1 text-green-400 text-xs">✓</div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Status Display */}
            <div className="text-center">
              {countdown !== null ? (
                <div className="tactical-overlay-red rounded-lg p-6 sm:p-8 animate-countdownPulse">
                  <div className="font-orbitron text-4xl sm:text-5xl lg:text-6xl font-black text-red-400 neon-text mb-2 sm:mb-4">
                    {countdown}
                  </div>
                  <div className="text-red-400 font-orbitron text-sm sm:text-base lg:text-xl tracking-widest">
                    MISSION COMMENCING
                  </div>
                </div>
              ) : players.length < 2 ? (
                <div className="tactical-overlay-yellow rounded-lg p-4 sm:p-6 animate-pulse">
                  <div className="text-yellow-400 font-orbitron text-sm sm:text-base lg:text-lg font-bold mb-2">
                    SEARCHING FOR OPERATORS...
                  </div>
                  <div className="text-gray-400 text-xs sm:text-sm">
                    [{players.length}/2] OPERATORS CONNECTED
                  </div>
                </div>
              ) : (
                <div className="tactical-overlay rounded-lg p-4 sm:p-6">
                  <div className="text-green-400 font-orbitron text-sm sm:text-base lg:text-lg font-bold">
                    AWAITING READY STATUS...
                  </div>
                  <div className="text-gray-400 text-xs sm:text-sm mt-2">
                    ALL OPERATORS MUST CONFIRM READY STATE
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : gameStatus === "ready" ? (
        <div className="relative w-full h-screen">
          {cameraError ? (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="tactical-overlay-red rounded-lg p-6 sm:p-8 max-w-md text-center animate-fadeIn hud-corner relative">
                <div className="text-red-400 text-4xl sm:text-6xl mb-4 sm:mb-6 animate-pulse">⚠</div>
                <h2 className="font-orbitron text-lg sm:text-xl font-bold text-red-400 mb-3 sm:mb-4">
                  SYSTEM ERROR
                </h2>
                <p className="text-xs sm:text-sm mb-4 sm:mb-6 text-gray-300">{cameraError}</p>
                <button
                  onClick={() => window.location.reload()}
                  className="bg-red-600/20 border-2 border-red-400 text-red-400 font-orbitron font-bold px-6 sm:px-8 py-2 sm:py-3 text-sm sm:text-base rounded-lg transition-all transform hover:scale-105 hover:bg-red-600/30"
                >
                  RETRY SYSTEM
                </button>
              </div>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                className="absolute inset-0 w-full h-full object-cover"
                playsInline
                muted
              />
              
              {/* AR Canvas */}
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[min(100vw,640px)] h-[min(100vh,480px)] sm:w-[640px] sm:h-[480px] border-2 border-blue-400">
                  <canvas ref={canvasRef} className="w-full h-full" />
                </div>

              {/* Tactical HUD - Health bars always shown on top */}
              <div className="absolute inset-0 pointer-events-none">
                {/* Top HUD - Player health bars always visible */}
                <div className="absolute top-1 md:top-2 lg:top-4 left-1 md:left-2 lg:left-4 right-1 md:right-2 lg:right-4 flex justify-between items-start gap-1 md:gap-2 lg:gap-4 animate-slideDown">
                  {/* Left Operator Panel */}
                  <div className="tactical-overlay rounded p-1 md:p-2 lg:p-4 min-w-16 md:min-w-20 lg:min-w-48 max-w-xs hud-corner relative animate-slideLeft text-xs md:text-sm">
                    <div className="scanline"></div>
                    {players.map((player) => (
                      player.id === socketId && (
                        <div key={player.id}>
                          <div className="flex justify-between items-center mb-1 md:mb-2">
                            <div className="font-orbitron font-bold text-green-400 text-xs md:text-sm">
                              OP-01
                            </div>
                            <div className="text-xs text-gray-400 hidden lg:block">
                              {new Date().toLocaleTimeString()}
                            </div>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between">
                              <span className="text-gray-400 text-xs">HP:</span>
                              <span className="text-green-400 font-orbitron font-bold ammo-counter text-xs">
                                {player.health}%
                              </span>
                            </div>
                            <div className="health-bar bg-gray-800 rounded-full h-1 md:h-2 overflow-hidden">
                              <div
                                className={`h-full transition-all duration-500 ${
                                  player.health > 70 ? "bg-green-400" : 
                                  player.health > 30 ? "bg-yellow-400" : "bg-red-400"
                                }`}
                                style={{ width: `${player.health}%` }}
                              ></div>
                            </div>
                          </div>
                        </div>
                      )
                    ))}
                  </div>

                  {/* Right Enemy Panel */}
                  <div className="tactical-overlay-red rounded p-1 md:p-2 lg:p-4 min-w-16 md:min-w-20 lg:min-w-48 max-w-xs hud-corner relative animate-slideRight text-xs md:text-sm">
                    <div className="scanline"></div>
                    {players.map((player) => (
                      player.id !== socketId && (
                        <div key={player.id}>
                          <div className="flex justify-between items-center mb-1 md:mb-2">
                            <div className="font-orbitron font-bold text-red-400 text-xs md:text-sm">
                              HOSTILE
                            </div>
                            <div className="w-2 h-2 md:w-3 md:h-3 bg-red-400 rounded-full animate-pulse"></div>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between">
                              <span className="text-gray-400 text-xs">THREAT:</span>
                              <span className="text-red-400 font-orbitron font-bold text-xs">
                                {player.health > 70 ? "HIGH" : player.health > 30 ? "MED" : "LOW"}
                              </span>
                            </div>
                            <div className="health-bar bg-gray-800 rounded-full h-1 md:h-2 overflow-hidden">
                              <div
                                className="h-full bg-red-400 transition-all duration-500"
                                style={{ width: `${player.health}%` }}
                              ></div>
                            </div>
                          </div>
                        </div>
                      )
                    ))}
                  </div>
                </div>

                {/* Bottom HUD - Controls */}
                <div className="absolute bottom-1 md:bottom-2 lg:bottom-4 left-1 md:left-2 lg:left-4 right-1 md:right-2 lg:right-4 flex flex-col sm:flex-row justify-between items-center gap-1 md:gap-2 lg:gap-4 animate-slideUp">
                  {/* Camera Controls - Hidden on small screens for space */}
                  <div className="tactical-overlay rounded p-1 md:p-2 lg:p-4 hud-corner animate-slideLeft pointer-events-auto w-full sm:w-auto  fixed bottom-2 left-1/2 transform -translate-x-1/2 z-10">
                    <div className="font-orbitron text-xs font-bold text-green-400 mb-1">
                      OPTIC
                    </div>
                    <select
                      value={selectedDeviceId || ""}
                      onChange={(e) => setSelectedDeviceId(e.target.value)}
                      className="bg-transparent border border-green-400/30 rounded px-2 py-1 text-xs font-orbitron text-green-400 focus:outline-none focus:border-green-400 w-full"
                    >
                      {videoDevices.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId} className="bg-black">
                          CAM-{index + 1}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Fire Control - Larger touch target on mobile */}
                    <div className="tactical-overlay-red rounded p-2 md:p-3 lg:p-6 hud-corner relative animate-slideUp pointer-events-auto order-2 sm:order-2">
                    <button
                      onClick={handleShoot}
                      className={`px-4 md:px-8 lg:px-12 py-2 md:py-4 lg:py-6 rounded-lg font-orbitron font-black text-sm md:text-base lg:text-xl transition-all duration-300 transform ${
                      isReloading
                        ? "bg-gray-700/50 cursor-not-allowed opacity-50 text-gray-400"
                        : "bg-red-600/20 border-2 border-red-400 text-red-400 hover:bg-red-600/40 hover:scale-110 animate-breathing neon-text"
                      }`}
                      disabled={isReloading}
                    >
                      {isReloading ? "RELOAD" : "FIRE"}
                    </button>
                    </div>

                    {/* Weapon Display - Compact on mobile */}
                    <div className={`tactical-overlay${
                    selectedGun === "sniper" ? "" : 
                    selectedGun === "pistol" ? "-red" : "-yellow"
                    } rounded p-1 md:p-2 lg:p-4 min-w-16 md:min-w-20 lg:min-w-32 text-center hud-corner relative animate-slideLeft w-full sm:w-auto order-1 sm:order-1`}>
                    <div className="scanline"></div>
                    <div className={`text-base md:text-xl lg:text-2xl mb-1 ${
                      selectedGun === "sniper" ? "text-green-400" :
                      selectedGun === "pistol" ? "text-red-400" : "text-yellow-400"
                    }`}>
                      {selectedGun === "sniper" ? "◊" : selectedGun === "pistol" ? "●" : "◈"}
                    </div>
                    <div className={`font-orbitron text-xs font-bold mb-1 ${
                      selectedGun === "sniper" ? "text-green-400" :
                      selectedGun === "pistol" ? "text-red-400" : "text-yellow-400"
                    }`}>
                      {selectedGun === "sniper" ? "SNP" : selectedGun === "pistol" ? "PST" : "SHG"}
                    </div>
                    <div className="text-xs text-gray-400 font-orbitron ammo-counter">
                      {isReloading ? "RLD" : "RDY"}
                    </div>
                    </div>
                </div>
              </div>

              <audio ref={sniperSoundRef} src="/sniper.mp3" preload="auto" />
              <audio ref={pistolSoundRef} src="/pistol.mp3" preload="auto" />
              <audio ref={shotgunSoundRef} src="/shotgun.mp3" preload="auto" />
              <audio ref={hitSoundRef} src="/hit.mp3" preload="auto" />
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center min-h-screen p-4">
          <div className="tactical-overlay rounded-lg p-6 sm:p-8 lg:p-12 text-center animate-fadeIn hud-corner relative max-w-sm sm:max-w-md">
            <div className="scanline"></div>
            <div className="text-6xl sm:text-7xl lg:text-8xl mb-6 sm:mb-8 animate-pulse">
              {winner === socketId ? "🏆" : "💀"}
            </div>
            <h1 className="font-orbitron text-2xl sm:text-3xl lg:text-4xl font-black mb-3 sm:mb-4 neon-text">
              {winner === socketId ? (
                <span className="text-green-400">MISSION COMPLETE</span>
              ) : (
                <span className="text-red-400">KIA</span>
              )}
            </h1>
            <p className="text-sm sm:text-base lg:text-lg mb-6 sm:mb-8 text-gray-400 font-orbitron">
              {winner === socketId ? "TARGET ELIMINATED" : "OPERATOR DOWN"}
            </p>
            <div className="space-y-3 sm:space-y-4">
              <div className="text-xs sm:text-sm text-gray-400 font-orbitron">
                DEBRIEFING COMPLETE
              </div>
              <button
                onClick={handleReset}
                className="bg-blue-600/20 border-2 border-blue-400 text-blue-400 font-orbitron font-bold py-3 sm:py-4 px-8 sm:px-10 lg:px-12 text-sm sm:text-base rounded-lg transition-all transform hover:scale-105 hover:bg-blue-600/30 neon-text"
              >
                NEW MISSION
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}