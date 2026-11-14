"use client";
import { createContext, createElement, useContext, useState } from "react";
import { useSlowlyWorkspace, useSlowlyBoards, useSlowlyTasks, useSlowlyWidgets } from "./use-slowly-api.mjs";

const Context = createContext(null);
export function ControlledApiProvider({ config, api, children }) {
  const [selection, setSelection] = useState({ mode: "localStorage", workspaceId: null, apiReady: false, allowWrites: false, boardId: null });
  const workspace = useSlowlyWorkspace({ ...selection, api, boardId: null, allowWrites: false });
  const owned = workspace.success && workspace.data?.data.settings?.controlledUiTestRun === config.runId;
  const options = { ...selection, api, apiReady: selection.apiReady && owned };
  const boards = useSlowlyBoards({ ...options, boardId: null, allowWrites: false });
  const boardId = boards.data.some(board => board.id === selection.boardId) ? selection.boardId : boards.data[0]?.id || null;
  const tasks = useSlowlyTasks({ ...options, boardId });
  const widgets = useSlowlyWidgets({ ...options, boardId });
  const widgetPresence = config.boardWidgetPresence[boardId] || "unknown";
  const connect = (workspaceId, ready) => {
    if (process.env.NODE_ENV === "production" || ready !== true || !config.allowedWorkspaces.some(item => item.id === workspaceId)) throw new Error("必須選擇測試 Workspace 並確認 API Ready。");
    setSelection({ mode: "api", workspaceId, apiReady: true, allowWrites: false, boardId: null });
  };
  const authorizeWrites = confirmation => {
    if (!owned || confirmation !== selection.workspaceId) throw new Error("請確認目前測試 Workspace ID。");
    setSelection(current => ({ ...current, allowWrites: true }));
  };
  const selectBoard = id => {
    if (!boards.data.some(board => board.id === id)) throw new Error("無效看板。");
    setSelection(current => ({ ...current, boardId: id, allowWrites: false }));
  };
  const disconnect = () => setSelection({ mode: "localStorage", workspaceId: null, apiReady: false, allowWrites: false, boardId: null });
  return createElement(Context.Provider, { value: { selection, owned, workspace, boards, tasks, widgets, boardId, widgetPresence, connect, authorizeWrites, selectBoard, disconnect } }, children);
}
export function useControlledApi() {
  const value = useContext(Context);
  if (!value) throw new Error("ControlledApiProvider is required");
  return value;
}
