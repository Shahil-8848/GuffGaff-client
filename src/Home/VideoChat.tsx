import React, { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Video, VideoOff, Mic, MicOff, Users, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Chat } from "./Chat";

interface VideoStreamState {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

interface ConnectionState {
  isConnected: boolean;
  isWaiting: boolean;
  error: string | null;
  status: string;
  isInitiator: boolean;
  reconnectAttempts: number;
}

interface Stats {
  totalUsers: number;
  waitingUsers: number;
  activePartnerships: number;
}

const BACKEND_URL =
  import.meta.env.NEXT_PUBLIC_BACKEND_URL || "https://guffgaff1.up.railway.app";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: "turn:numb.viagenie.ca",
    username: "webrtc@live.com",
    credential: "muazkh",
  },
];

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

export default function VideoChat() {
  const [streams, setStreams] = useState<VideoStreamState>({
    localStream: null,
    remoteStream: null,
  });

  const [connectionState, setConnectionState] = useState<ConnectionState>({
    isConnected: false,
    isWaiting: false,
    error: null,
    status: "Initializing...",
    isInitiator: false,
    reconnectAttempts: 0,
  });

  const [controls, setControls] = useState({
    isMuted: false,
    isVideoOff: false,
  });

  const [stats, setStats] = useState<Stats>({
    totalUsers: 0,
    waitingUsers: 0,
    activePartnerships: 0,
  });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const isNegotiatingRef = useRef(false);
  const makingOfferRef = useRef(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const cleanupPeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setStreams((prev) => ({ ...prev, remoteStream: null }));
  }, []);

  const handleDisconnect = useCallback(() => {
    cleanupPeerConnection();
    setConnectionState((prev) => ({
      ...prev,
      isConnected: false,
      isWaiting: false,
      status: "Disconnected",
      isInitiator: false,
    }));
  }, [cleanupPeerConnection]);

  const createPeerConnection = useCallback(async () => {
    try {
      cleanupPeerConnection();

      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        iceTransportPolicy: "all",
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
        iceCandidatePoolSize: 1,
      });

      peerConnectionRef.current = pc;

      pc.onnegotiationneeded = async () => {
        try {
          if (isNegotiatingRef.current || !connectionState.isInitiator) return;
          isNegotiatingRef.current = true;
          makingOfferRef.current = true;

          await pc.setLocalDescription();
          socketRef.current?.emit("offer", {
            peerId: socketRef.current.id,
            offer: pc.localDescription,
          });
        } catch (err) {
          console.error("Negotiation error:", err);
          setConnectionState((prev) => ({
            ...prev,
            error: "Connection negotiation failed",
          }));
        } finally {
          makingOfferRef.current = false;
          isNegotiatingRef.current = false;
        }
      };

      if (streams.localStream) {
        streams.localStream.getTracks().forEach((track) => {
          pc.addTrack(track, streams.localStream!);
        });
      }

      pc.ontrack = (event) => {
        if (event.streams?.[0]) {
          setStreams((prev) => ({ ...prev, remoteStream: event.streams[0] }));
          setConnectionState((prev) => ({
            ...prev,
            isConnected: true,
            status: "Connected to partner",
            error: null,
          }));
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current?.connected) {
          socketRef.current.emit("ice-candidate", {
            peerId: socketRef.current.id,
            candidate: event.candidate,
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("ICE Connection State:", pc.iceConnectionState);

        switch (pc.iceConnectionState) {
          case "failed":
            if (connectionState.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
              setConnectionState((prev) => ({
                ...prev,
                reconnectAttempts: prev.reconnectAttempts + 1,
                status: "Connection failed. Attempting to reconnect...",
              }));

              if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
              }

              reconnectTimeoutRef.current = setTimeout(() => {
                findPartner();
              }, RECONNECT_DELAY);
            } else {
              handleDisconnect();
              setConnectionState((prev) => ({
                ...prev,
                error: "Connection failed after multiple attempts",
              }));
            }
            break;

          case "disconnected":
            setConnectionState((prev) => ({
              ...prev,
              status: "Connection interrupted. Attempting to restore...",
            }));
            break;

          case "connected":
            setConnectionState((prev) => ({
              ...prev,
              reconnectAttempts: 0,
              error: null,
              status: "Connected to partner",
            }));
            break;
        }
      };

      return pc;
    } catch (err) {
      console.error("Error creating peer connection:", err);
      setConnectionState((prev) => ({
        ...prev,
        error: "Failed to create peer connection",
      }));
      return null;
    }
  }, [
    streams.localStream,
    connectionState.isInitiator,
    connectionState.reconnectAttempts,
    handleDisconnect,
    cleanupPeerConnection,
  ]);

  const initializeSocket = useCallback(() => {
    if (socketRef.current?.connected) return;

    console.log("Initializing socket connection to:", BACKEND_URL);

    const socket = io(BACKEND_URL, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      reconnectionDelay: RECONNECT_DELAY,
      timeout: 20000,
      forceNew: true,
      withCredentials: true,
    });

    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error);
      setConnectionState((prev) => ({
        ...prev,
        error: `Connection error: ${error.message}`,
      }));
    });

    socket.on("connect", () => {
      console.log("Connected to signaling server");
      setConnectionState((prev) => ({
        ...prev,
        error: null,
        status: "Connected to server",
      }));
    });

    socket.on("match", async ({ peerId }) => {
      try {
        setConnectionState((prev) => ({
          ...prev,
          isInitiator: true,
          isWaiting: false,
          status: "Partner found! Establishing connection...",
        }));

        await createPeerConnection();
      } catch (err) {
        console.error("Match handling error:", err);
        handleDisconnect();
      }
    });

    socket.on("offer", async ({ peerId, offer }) => {
      try {
        const pc = peerConnectionRef.current || (await createPeerConnection());
        if (!pc) return;

        const offerCollision =
          makingOfferRef.current ||
          (pc.signalingState !== "stable" && !connectionState.isInitiator);

        if (offerCollision) {
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", { peerId, answer });
      } catch (err) {
        console.error("Offer handling error:", err);
        handleDisconnect();
      }
    });

    socket.on("answer", async ({ answer }) => {
      try {
        const pc = peerConnectionRef.current;
        if (!pc) return;

        const remoteDesc = new RTCSessionDescription(answer);
        await pc.setRemoteDescription(remoteDesc);
      } catch (err) {
        console.error("Answer handling error:", err);
        handleDisconnect();
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      try {
        const pc = peerConnectionRef.current;
        if (!pc || !pc.remoteDescription) return;

        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("ICE candidate error:", err);
      }
    });

    socket.on("partner-left", () => {
      handleDisconnect();
      setConnectionState((prev) => ({
        ...prev,
        status: "Partner left. You can find a new partner.",
      }));
    });

    socket.on("waiting", () => {
      setConnectionState((prev) => ({
        ...prev,
        isWaiting: true,
        status: "Waiting for a partner...",
      }));
    });

    socket.on("stats-update", (newStats: Stats) => {
      setStats(newStats);
    });

    socketRef.current = socket;
    return socket;
  }, [createPeerConnection, handleDisconnect]);

  const initializeMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      setStreams((prev) => ({ ...prev, localStream: stream }));
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (error: any) {
      setConnectionState((prev) => ({
        ...prev,
        error: `Camera/Microphone access failed: ${error.message}`,
      }));
    }
  };

  const findPartner = useCallback(() => {
    if (!socketRef.current?.connected) {
      initializeSocket();
      return;
    }

    cleanupPeerConnection();
    setConnectionState((prev) => ({
      ...prev,
      isConnected: false,
      isWaiting: true,
      status: "Looking for a partner...",
    }));

    socketRef.current.emit("find-match");
  }, [initializeSocket, cleanupPeerConnection]);

  const toggleAudio = useCallback(() => {
    if (streams.localStream) {
      const audioTracks = streams.localStream.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setControls((prev) => ({ ...prev, isMuted: !prev.isMuted }));
    }
  }, [streams.localStream]);

  const toggleVideo = useCallback(() => {
    if (streams.localStream) {
      const videoTracks = streams.localStream.getVideoTracks();
      videoTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setControls((prev) => ({ ...prev, isVideoOff: !prev.isVideoOff }));
    }
  }, [streams.localStream]);

  useEffect(() => {
    console.log("Attempting to connect to:", BACKEND_URL);
    initializeMedia();
    const socket = initializeSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      streams.localStream?.getTracks().forEach((track) => track.stop());
      cleanupPeerConnection();
      socket?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = streams.remoteStream;
    }
  }, [streams.remoteStream]);

  return (
    <div className="flex flex-col min-h-screen p-4 bg-gray-50 dark:bg-gray-900">
      <div className="flex justify-center gap-4 mb-4">
        <Badge variant="secondary">
          <Users className="w-4 h-4 mr-2" />
          {stats.totalUsers} Online
        </Badge>
        <Badge variant="secondary">{stats.waitingUsers} Waiting</Badge>
        <Badge variant="secondary">
          {stats.activePartnerships} Active Chats
        </Badge>
      </div>

      {connectionState.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{connectionState.error}</AlertDescription>
        </Alert>
      )}

      <Alert variant="info" className="mb-4">
        <AlertDescription>{connectionState.status}</AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1">
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="relative">
              <CardContent className="p-2">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full rounded-lg object-cover bg-black"
                  style={{ transform: "scaleX(-1)" }}
                />
                <div className="absolute bottom-4 left-4 bg-black/50 px-2 py-1 rounded text-white">
                  You {controls.isMuted && "(Muted)"}{" "}
                  {controls.isVideoOff && "(Video Off)"}
                </div>
              </CardContent>
            </Card>

            <Card className="relative">
              <CardContent className="p-2">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full rounded-lg object-cover bg-black"
                />
                <div className="absolute bottom-4 left-4 bg-black/50 px-2 py-1 rounded text-white">
                  {connectionState.isConnected
                    ? "Partner"
                    : connectionState.isWaiting
                    ? "Finding partner..."
                    : "No one connected"}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-center space-x-4">
            <Button
              variant={controls.isMuted ? "destructive" : "default"}
              onClick={toggleAudio}
              className="w-12 h-12 rounded-full p-0"
            >
              {controls.isMuted ? (
                <MicOff className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </Button>

            <Button
              variant={controls.isVideoOff ? "destructive" : "default"}
              onClick={toggleVideo}
              className="w-12 h-12 rounded-full p-0"
            >
              {controls.isVideoOff ? (
                <VideoOff className="h-5 w-5" />
              ) : (
                <Video className="h-5 w-5" />
              )}
            </Button>

            <Button
              variant="outline"
              onClick={findPartner}
              disabled={connectionState.isWaiting}
              className="w-12 h-12 rounded-full p-0"
            >
              <RefreshCw
                className={`h-5 w-5 ${
                  connectionState.isWaiting ? "animate-spin" : ""
                }`}
              />
            </Button>
          </div>
        </div>

        <div className="lg:col-span-1">
          <Chat
            socket={socketRef.current}
            isConnected={connectionState.isConnected}
          />
        </div>
      </div>
    </div>
  );
}
