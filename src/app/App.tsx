import { useGraphController } from "../features/graph-editor";
import { LocateFixed, Minus, Plus } from "lucide-react";
import { DomGraphRenderer } from "../features/dom-graph-renderer";
import { WebGpuGraphRenderer } from "../features/webgpu-renderer";
import { Chat, useLLMChatController } from "../features/chat";
import styles from "./ui/App.module.css";

function App() {
  const {
    boardRef,
    centerGraph,
    edges,
    nodeById,
    nodes,
    onNodeDragStart,
    renderMode,
    setRenderMode,
    viewport,
    webGpuAvailable,
    zoomIn,
    zoomOut,
  } = useGraphController();
  const { engineStatus, errorMessage, messages, loading, onMessageSend } = useLLMChatController();

  return (
    <main className={styles.app}>
      <div className={styles.atmospherePrimary} />
      <div className={styles.atmosphereAccent} />

      <div className={styles.workspace}>
        <header className={styles.toolbar} data-role="toolbar">
          <div>
            <h1 className={styles.title}>Graph Draft</h1>
          </div>
          <div className={styles.toolbarControls}>
            <div className={styles.rendererToggle}>
              <button
                type="button"
                className={renderMode === "dom" ? styles.modeButtonActive : styles.modeButton}
                onClick={() => setRenderMode("dom")}
              >
                DOM
              </button>
              <button
                type="button"
                className={renderMode === "webgpu" ? styles.modeButtonActive : styles.modeButton}
                onClick={() => setRenderMode("webgpu")}
                disabled={!webGpuAvailable}
                title={!webGpuAvailable ? "WebGPU is unavailable in this browser." : "Switch to WebGPU renderer"}
              >
                WebGPU
              </button>
            </div>
          </div>
        </header>

        <div className={styles.workspaceBody}>
          <section ref={boardRef} className={styles.board}>
            <nav className={styles.quickMenu} data-role="toolbar">
              <button type="button" className={styles.menuItemActive}>
                Workspace
              </button>
              <button type="button" className={styles.menuItem}>
                Analytics
              </button>
              <button type="button" className={styles.menuItem}>
                Layers
              </button>
            </nav>

            <div className={styles.boardControls} data-role="toolbar">
              <button
                type="button"
                className={styles.controlButton}
                onClick={zoomOut}
                title="Zoom out"
                aria-label="Zoom out"
              >
                <Minus className={styles.controlIcon} />
              </button>
              <button
                type="button"
                className={styles.controlButton}
                onClick={zoomIn}
                title="Zoom in"
                aria-label="Zoom in"
              >
                <Plus className={styles.controlIcon} />
              </button>
              <button
                type="button"
                className={styles.controlButton}
                onClick={centerGraph}
                title="Center graph"
                aria-label="Center graph"
              >
                <LocateFixed className={styles.controlIcon} />
              </button>
            </div>

            {renderMode === "dom" ? (
              <DomGraphRenderer
                edges={edges}
                nodeById={nodeById}
                nodes={nodes}
                onNodeDragStart={onNodeDragStart}
                viewport={viewport}
              />
            ) : (
              <WebGpuGraphRenderer edges={edges} nodes={nodes} viewport={viewport} />
            )}
          </section>
          <Chat
            engineStatus={engineStatus}
            errorMessage={errorMessage}
            messages={messages}
            loading={loading}
            onMessageSend={onMessageSend}
          />
        </div>
      </div>
    </main>
  );
}

export default App;
