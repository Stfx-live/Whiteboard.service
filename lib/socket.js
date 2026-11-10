import { io } from "socket.io-client";
import { API } from "./api";

export const socket = io(API || window.location.origin, {
  autoConnect: false,
  path: "/socket.io",
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 300,
  reconnectionDelayMax: 3000,
});
