import { buildBVH } from "./bvh.js";
import { hydrateIcons } from "./icons.js";
import { PathTracer } from "./renderer.js";
import {
  DEFAULT_STATE,
  RESOLUTIONS,
  buildLight,
  buildMaterials,
  buildPrimitives,
  cameraBasis,
  clampCamera,
  hydrateState,
  resolutionInfo,
  resetUnlockedMaterials,
  sceneSignature,
  serializeState,
} from "./scene.js";
import { clearSnapshot, loadSnapshot, saveSnapshot } from "./storage.js";
import { StudioUI } from "./ui.js";

const STATE_KEY = "caustic-studio-state-v1";
const AUTO_SAVE_INTERVAL = 8000;

hydrateIcons();

const loadState = () => {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { state: hydrateState(null), restored: false };
    return { state: hydrateState(JSON.parse(raw)), restored: true };
  } catch (error) {
    console.warn("无法读取本地状态，使用默认场景", error);
    return { state: hydrateState(null), restored: false };
  }
};

const initial = loadState();
let state = initial.state;
let renderer = null;
let ui = null;
let paused = false;
let interactionCounter = 0;
let snapshotDirty = false;
let saveInFlight = false;
let lastSaveAttempt = 0;
let lastSavedSpp = 0;
let lastAccumulationCamera = null;
let lastStatsAt = 0;
let stateSaveTimer = 0;
let wheelTimer = 0;
let frameHandle = 0;

const canvas = document.querySelector("#viewport");
const pointers = new Map();
let dragging = false;
let pinchStartDistance = 0;
let pinchStartCameraDistance = 0;

const persistStateNow = () => {
  try {
    localStorage.setItem(STATE_KEY, serializeState(state));
  } catch (error) {
    console.warn("无法写入本地状态", error);
  }
};

const scheduleStateSave = () => {
  window.clearTimeout(stateSaveTimer);
  stateSaveTimer = window.setTimeout(persistStateNow, 180);
};

const copyCamera = (camera) => ({
  yaw: camera.yaw,
  pitch: camera.pitch,
  dist: camera.dist,
  target: [...camera.target],
});

const markSnapshotDirty = (showStatus = true) => {
  snapshotDirty = true;
  if (showStatus && ui) ui.setSaveStatus("dirty");
};

const applyCamera = () => {
  state.camera = clampCamera(state.camera);
  renderer.setCamera(cameraBasis(state.camera));
  scheduleStateSave();
  markSnapshotDirty();
};

const rebuildScene = () => {
  const primitives = buildPrimitives(state);
  const bvh = buildBVH(primitives);
  const materials = buildMaterials(state);
  const light = buildLight(state);
  renderer.setScene({ primitives, bvh, materials, light });
  renderer.setCamera(cameraBasis(state.camera));
  renderer.setInteracting(interactionCounter > 0);
  persistStateNow();
  markSnapshotDirty();
};

const createSnapshotRecord = (snapshot, reason) => {
  const accumulationCamera = lastAccumulationCamera || copyCamera(state.camera);
  return {
    version: 1,
    fingerprint: sceneSignature(state),
    camera: copyCamera(accumulationCamera),
    width: snapshot.width,
    height: snapshot.height,
    accumulation: snapshot.accumulation,
    position: snapshot.position,
    sampleEstimate: snapshot.sampleEstimate,
    frameSeed: snapshot.frameSeed,
    paused,
    reason,
  };
};

const saveNow = async ({ manual = false, reason = "auto" } = {}) => {
  if (!renderer || !renderer.ready || saveInFlight) {
    if (manual && ui) ui.toast("当前没有可保存的渲染结果", "error");
    return false;
  }
  if (!manual && renderer.sampleEstimate <= 0) return false;
  saveInFlight = true;
  snapshotDirty = false;
  lastSaveAttempt = performance.now();
  if (ui) ui.setSaveStatus("saving");
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const snapshot = renderer.readSnapshot();
    if (!snapshot) throw new Error("无法读取累积缓冲");
    const record = createSnapshotRecord(snapshot, reason);
    await saveSnapshot(record);
    lastSavedSpp = snapshot.sampleEstimate;
    if (ui) {
      ui.setSaveStatus("saved", { savedAt: Date.now(), spp: snapshot.sampleEstimate });
      if (manual) ui.toast(`已保存 ${Math.round(snapshot.sampleEstimate).toLocaleString("zh-CN")} spp`, "success");
    }
    return true;
  } catch (error) {
    console.error("保存累积失败", error);
    snapshotDirty = true;
    if (ui) ui.setSaveStatus("error", { message: error && error.message ? error.message : "本地存储写入失败" });
    if (manual && ui) ui.toast("保存失败，请检查浏览器存储空间", "error");
    return false;
  } finally {
    saveInFlight = false;
  }
};

const clearAccumulation = async ({ announce = true } = {}) => {
  if (!renderer || !renderer.ready) return;
  renderer.resetAccumulation();
  renderer.present();
  try {
    await clearSnapshot();
  } catch (error) {
    console.warn("无法清除旧快照", error);
  }
  lastSavedSpp = 0;
  if (ui) {
    ui.setSaveStatus("idle");
    ui.setStats({ spp: 0, rate: `${state.render.samplesPerFrame} spp / 帧`, fps: 0, historyActive: state.render.historyReprojection, cameraMoving: false });
    if (announce) ui.toast("累积缓冲已清除，重新开始采样", "success");
  }
};

const saveOnPageHide = () => {
  if (!renderer || !renderer.ready || renderer.sampleEstimate <= 0) return;
  try {
    const snapshot = renderer.readSnapshot();
    if (!snapshot) return;
    saveSnapshot(createSnapshotRecord(snapshot, "pagehide")).catch(() => {});
    lastSavedSpp = snapshot.sampleEstimate;
  } catch (error) {
    console.warn("页面关闭前的快照写入未完成", error);
  }
};

const togglePause = async () => {
  if (!renderer || !renderer.ready) return;
  paused = !paused;
  ui.setPaused(paused);
  renderer.setInteracting(false);
  interactionCounter = 0;
  window.clearTimeout(wheelTimer);
  pointers.clear();
  dragging = false;
  canvas.classList.remove("is-dragging");
  if (paused) {
    renderer.present();
    ui.setStats({
      spp: renderer.sampleEstimate,
      rate: "已暂停",
      fps: 0,
      historyActive: state.render.historyReprojection,
      cameraMoving: false,
    });
    if (renderer.sampleEstimate > 0) saveNow({ reason: "pause" });
    else ui.setSaveStatus("idle");
  }
};

const setInteraction = (delta) => {
  interactionCounter = Math.max(0, interactionCounter + delta);
  if (renderer) renderer.setInteracting(interactionCounter > 0);
};

const applyOrbit = (dx, dy) => {
  state.camera.yaw -= dx * 0.0048;
  state.camera.pitch = Math.min(1.15, Math.max(0.02, state.camera.pitch + dy * 0.0048));
  applyCamera();
};

const applyZoom = (factor) => {
  state.camera.dist = Math.min(12.5, Math.max(3.2, state.camera.dist * factor));
  applyCamera();
};

const onRenderChange = (field, value) => {
  if (!renderer || !renderer.ready) return;
  if (field === "samplesPerFrame") {
    renderer.setOptions({ samplesPerFrame: value });
    persistStateNow();
    return;
  }
  if (field === "maxBounces") {
    renderer.setOptions({ maxBounces: value });
    renderer.resetAccumulation();
    persistStateNow();
    markSnapshotDirty();
    return;
  }
  if (field === "exposure") {
    renderer.setOptions({ exposure: value });
    if (paused) renderer.present();
    persistStateNow();
    return;
  }
  if (field === "historyReprojection") {
    renderer.setOptions({ historyReprojection: value });
    persistStateNow();
    if (ui) ui.setHistory(value, false);
    return;
  }
  if (field === "resolution") {
    const resolution = RESOLUTIONS.find((entry) => entry.id === value);
    if (!resolution) return;
    renderer.resize(resolution.width, resolution.height);
    renderer.setCamera(cameraBasis(state.camera));
    renderer.present();
    renderer.setOptions({
      samplesPerFrame: state.render.samplesPerFrame,
      maxBounces: state.render.maxBounces,
      exposure: state.render.exposure,
      historyReprojection: state.render.historyReprojection,
    });
    lastSavedSpp = 0;
    clearSnapshot().catch(() => {});
    persistStateNow();
    markSnapshotDirty();
    if (ui) {
      ui.updateResolutionLabel();
      ui.setStats({
        spp: 0,
        rate: `${state.render.samplesPerFrame} spp / 帧`,
        fps: 0,
        historyActive: state.render.historyReprojection,
        cameraMoving: false,
      });
    }
  }
};

const onMaterialChange = () => {
  if (!renderer || !renderer.ready) return;
  rebuildScene();
};

const onLockChange = () => {
  persistStateNow();
};

const onResetUnlocked = () => {
  state = resetUnlockedMaterials(state);
  if (ui) ui.sync(state);
  rebuildScene();
  persistStateNow();
  ui.toast("未锁定材质已重置，锁定项保持不变", "success");
};

const resetCamera = () => {
  if (!renderer || !renderer.ready) return;
  state.camera = {
    yaw: DEFAULT_STATE.camera.yaw,
    pitch: DEFAULT_STATE.camera.pitch,
    dist: DEFAULT_STATE.camera.dist,
    target: [...DEFAULT_STATE.camera.target],
  };
  applyCamera();
  if (ui) ui.toast("相机视角已复位", "info");
};

const onPointerDown = (event) => {
  if (paused || !renderer || !renderer.ready) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY });
  if (pointers.size === 1) {
    dragging = true;
    setInteraction(1);
    canvas.classList.add("is-dragging");
  } else if (pointers.size === 2) {
    const first = [...pointers.values()][0];
    const second = [...pointers.values()][1];
    pinchStartDistance = Math.hypot(second.x - first.x, second.y - first.y);
    pinchStartCameraDistance = state.camera.dist;
    dragging = false;
  }
};

const onPointerMove = (event) => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (pointers.size >= 2) {
    const first = [...pointers.values()][0];
    const second = [...pointers.values()][1];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (pinchStartDistance > 0 && distance > 0) {
      const target = pinchStartCameraDistance * (pinchStartDistance / distance);
      state.camera.dist = Math.min(12.5, Math.max(3.2, target));
      applyCamera();
    }
    return;
  }
  if (!dragging) return;
  const dx = pointer.x - pointer.lastX;
  const dy = pointer.y - pointer.lastY;
  pointer.lastX = pointer.x;
  pointer.lastY = pointer.y;
  applyOrbit(dx, dy);
};

const endPointer = (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (pointers.size === 1) {
    const remaining = [...pointers.values()][0];
    dragging = true;
    remaining.lastX = remaining.x;
    remaining.lastY = remaining.y;
    pinchStartDistance = 0;
  } else if (pointers.size === 0) {
    dragging = false;
    pinchStartDistance = 0;
    canvas.classList.remove("is-dragging");
    setInteraction(-1);
  }
};

const onWheel = (event) => {
  if (paused || !renderer || !renderer.ready) return;
  event.preventDefault();
  applyZoom(Math.exp(event.deltaY * 0.0011));
  setInteraction(1);
  window.clearTimeout(wheelTimer);
  wheelTimer = window.setTimeout(() => setInteraction(-1), 180);
};

const onKeyDown = (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("input, select, textarea, button")) return;
  if (event.code === "Space") {
    event.preventDefault();
    togglePause();
    return;
  }
  if (event.key === "r" || event.key === "R") {
    event.preventDefault();
    clearAccumulation();
  }
};

const setupInteraction = () => {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", resetCamera);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    window.cancelAnimationFrame(frameHandle);
    if (ui) {
      ui.setGpuState("error", "GPU 上下文丢失");
      ui.showError("WebGL 上下文已丢失，请刷新页面继续渲染。");
    }
  });
  window.addEventListener("keydown", onKeyDown);
  document.querySelector("#errorClose").addEventListener("click", () => ui.hideError());
};

const updateStats = (timestamp, stats) => {
  if (!stats) return;
  if (timestamp - lastStatsAt < 110) return;
  lastStatsAt = timestamp;
  const rate = stats.rebuilding
    ? `${stats.spp} spp / 帧 · 重投影`
    : `${stats.spp} spp / 帧`;
  ui.setStats({
    spp: stats.estimatedSpp,
    rate,
    fps: stats.fps,
    historyActive: state.render.historyReprojection,
    cameraMoving: stats.rebuilding,
  });
};

const frame = (timestamp) => {
  if (!paused && renderer && renderer.ready) {
    const stats = renderer.renderFrame(timestamp);
    if (stats) {
      lastAccumulationCamera = copyCamera(state.camera);
      updateStats(timestamp, stats);
      if (
        !interactionCounter &&
        !saveInFlight &&
        renderer.sampleEstimate > 0 &&
        timestamp - lastSaveAttempt > AUTO_SAVE_INTERVAL
      ) {
        saveNow({ reason: "auto" });
      }
    }
  }
  frameHandle = window.requestAnimationFrame(frame);
};

const callbacks = {
  onTogglePause: togglePause,
  onSave: () => saveNow({ manual: true, reason: "manual" }),
  onClearAccum: () => clearAccumulation(),
  onRenderChange,
  onMaterialChange,
  onLockChange,
  onResetUnlocked,
};

const bootSnapshot = async () => {
  let snapshot = null;
  try {
    snapshot = await loadSnapshot();
  } catch (error) {
    console.warn("无法读取累积快照", error);
    return;
  }
  if (!snapshot) return;
  const fingerprint = sceneSignature(state);
  const validResolution = snapshot.width === renderer.width && snapshot.height === renderer.height;
  if (snapshot.fingerprint !== fingerprint || !validResolution || snapshot.version !== 1) {
    await clearSnapshot().catch(() => {});
    ui.setSaveStatus("idle");
    return;
  }
  if (snapshot.camera && Array.isArray(snapshot.camera.target) && snapshot.camera.target.length === 3) {
    state.camera = clampCamera(snapshot.camera);
    renderer.setCamera(cameraBasis(state.camera));
  }
  const restored = renderer.restoreSnapshot(snapshot);
  if (!restored) {
    ui.setSaveStatus("idle");
    return;
  }
  lastSavedSpp = snapshot.sampleEstimate;
  lastSaveAttempt = performance.now();
  lastAccumulationCamera = copyCamera(state.camera);
  persistStateNow();
  ui.setSaveStatus("saved", { savedAt: snapshot.savedAt, spp: snapshot.sampleEstimate });
  ui.toast(`已恢复 ${Math.round(snapshot.sampleEstimate).toLocaleString("zh-CN")} spp，继续累积`, "success");
  ui.setStats({
    spp: snapshot.sampleEstimate,
    rate: `${state.render.samplesPerFrame} spp / 帧`,
    fps: 0,
    historyActive: state.render.historyReprojection,
    cameraMoving: false,
  });
};

const boot = async () => {  ui = new StudioUI(callbacks);
  ui.build(state);
  setupInteraction();
  ui.setSaveStatus("idle");
  const resolution = resolutionInfo(state);
  try {
    renderer = new PathTracer(canvas);
    renderer.init(resolution.width, resolution.height);
    renderer.setOptions({
      samplesPerFrame: state.render.samplesPerFrame,
      maxBounces: state.render.maxBounces,
      exposure: state.render.exposure,
      historyReprojection: state.render.historyReprojection,
    });
    renderer.setCamera(cameraBasis(state.camera));
    const primitives = buildPrimitives(state);
    const bvh = buildBVH(primitives);
    renderer.setScene({ primitives, bvh, materials: buildMaterials(state), light: buildLight(state) });
    ui.setGpuState("ready", "WebGL2 · 浮点累积");
    ui.updateResolutionLabel();
    await bootSnapshot();
    persistStateNow();
    frameHandle = window.requestAnimationFrame(frame);
    if (initial.restored && lastSavedSpp <= 0) ui.toast("已恢复上次的相机与材质设置", "info");
    window.addEventListener("pagehide", saveOnPageHide);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && renderer && renderer.ready && renderer.sampleEstimate > 0) {
        saveNow({ reason: "hidden" });
      }
    });
    window.addEventListener("beforeunload", persistStateNow);
  } catch (error) {
    console.error(error);
    ui.setGpuState("error", "WebGL2 不可用");
    ui.showError(error && error.message ? error.message : "渲染器初始化失败。");
  }
};

boot();
