import { useEffect, useRef, useState } from "react";
import type { ChatCompletionMessageParam, WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import type { EdgeType } from "../../../entities/edge";
import type { NodeType } from "../../../entities/node";
import type { GraphApi } from "../../graph-editor";
import { createWorkerEngine } from "../../../lib/web-llm";
import { buildSystemPrompt } from "./plannerPrompt";
import { executePlannerActions, parsePlannerResponse } from "./plannerParser";
import type { ChatDisplayMessage, ChatEngineStatus, EngineLoadingProgress } from "./types";

type Params = {
  graphApi: GraphApi;
  nodes: NodeType[];
  edges: EdgeType[];
};

export const useLLMChatController = ({ graphApi, nodes, edges }: Params) => {
  const [history, setHistory] = useState<ChatCompletionMessageParam[]>([]);
  const [displayMessages, setDisplayMessages] = useState<ChatDisplayMessage[]>([]);
  const [engineStatus, setEngineStatus] = useState<ChatEngineStatus>("idle");
  const [loadingProgress, setLoadingProgress] = useState<EngineLoadingProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const engine = useRef<WebWorkerMLCEngine>(null);
  const historyRef = useRef<ChatCompletionMessageParam[]>(history);
  const nodesRef = useRef<NodeType[]>(nodes);
  const edgesRef = useRef<EdgeType[]>(edges);
  const graphApiRef = useRef<GraphApi>(graphApi);

  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { graphApiRef.current = graphApi; }, [graphApi]);

  useEffect(() => {
    let disposed = false;

    const startLLM = async () => {
      setEngineStatus("loading");
      setErrorMessage(null);

      try {
        const nextEngine = await createWorkerEngine({
          onInitProgress: (report) => {
            const r = report as { text: string; progress: number };
            setLoadingProgress({ text: r.text, progress: r.progress });
          },
        });
        if (disposed) return;

        engine.current = nextEngine;
        setLoadingProgress(null);
        setEngineStatus("ready");
      } catch {
        if (disposed) return;

        setEngineStatus("error");
        setErrorMessage("Failed to initialize LLM engine.");
      }
    };

    startLLM();

    return () => {
      disposed = true;
    };
  }, []);

  const onMessageSend = async (rawInput: string) => {
    const userInput = rawInput.trim();
    if (!userInput) return;
    if (engineStatus !== "ready" || !engine.current) return;

    setLoading(true);

    const userMessage: ChatCompletionMessageParam = { role: "user", content: userInput };
    const nextHistory = [...historyRef.current, userMessage];
    historyRef.current = nextHistory;
    setHistory(nextHistory);
    setDisplayMessages((prev) => [...prev, { role: "user", content: userInput }]);

    try {
      const systemMessage: ChatCompletionMessageParam = {
        role: "system",
        content: buildSystemPrompt(nodesRef.current, edgesRef.current),
      };

      const reply = await engine.current.chat.completions.create({
        messages: [systemMessage, ...nextHistory],
        response_format: { type: "json_object" },
      });

      const assistantMessage = reply.choices?.[0]?.message;
      if (!assistantMessage) return;

      const updatedHistory = [...historyRef.current, assistantMessage];
      historyRef.current = updatedHistory;
      setHistory(updatedHistory);

      const content = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
      const parsed = parsePlannerResponse(content);

      if (parsed) {
        executePlannerActions(parsed, graphApiRef.current);
        setDisplayMessages((prev) => [...prev, { role: "assistant", content: parsed.reply }]);
      } else {
        setDisplayMessages((prev) => [...prev, { role: "assistant", content: content }]);
      }
    } catch (error) {
      console.error("Failed to send message", error);
    } finally {
      setLoading(false);
    }
  };

  return { displayMessages, engineStatus, loadingProgress, errorMessage, loading, onMessageSend };
};
