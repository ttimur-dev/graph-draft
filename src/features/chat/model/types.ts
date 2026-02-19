export type ChatEngineStatus = "idle" | "loading" | "ready" | "error";

export type ChatDisplayMessage = {
  role: "user" | "assistant";
  content: string;
};

export type EngineLoadingProgress = {
  text: string;
  progress: number;
};
