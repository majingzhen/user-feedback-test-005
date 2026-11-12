import { iconMarkup } from "./icons.js";
import { MATERIAL_KEYS, MATERIAL_META, RESOLUTIONS, resolutionInfo } from "./scene.js";

const MATERIAL_CONTROLS = {
  metal: [
    { prop: "roughness", label: "粗糙度", min: 0.02, max: 0.6, step: 0.01, format: (value) => value.toFixed(2) },
  ],
  glass: [
    { prop: "ior", label: "折射率", min: 1.05, max: 2.4, step: 0.01, format: (value) => value.toFixed(2) },
  ],
  floor: [],
  light: [
    { prop: "intensity", label: "发光强度", min: 1, max: 18, step: 0.1, format: (value) => value.toFixed(1) },
    { prop: "width", label: "光源宽度", min: 1, max: 6, step: 0.1, format: (value) => value.toFixed(1) },
    { prop: "height", label: "光源深度", min: 0.6, max: 4, step: 0.1, format: (value) => value.toFixed(1) },
    { prop: "elevation", label: "悬挂高度", min: 2.4, max: 6, step: 0.1, format: (value) => value.toFixed(1) },
  ],
};

const numberFormat = (value) => Math.round(value).toLocaleString("zh-CN");

const formatTime = (date) =>
  new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);

export class StudioUI {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.state = null;
    this.selectedMaterial = "metal";
    this.sppTarget = 2048;
    this.paused = false;
    this.lastSave = null;
    this.refs = {
      gpuPill: document.querySelector("#gpuPill"),
      gpuLabel: document.querySelector("#gpuLabel"),
      renderTag: document.querySelector("#renderTag"),
      historyState: document.querySelector("#historyState"),
      sppValue: document.querySelector("#sppValue"),
      sppRate: document.querySelector("#sppRate"),
      fpsValue: document.querySelector("#fpsValue"),
      saveState: document.querySelector("#saveState"),
      progressBar: document.querySelector("#progressBar"),
      pauseBtn: document.querySelector("#pauseBtn"),
      pauseLabel: document.querySelector("#pauseLabel"),
      hudPauseBtn: document.querySelector("#hudPauseBtn"),
      pauseBadge: document.querySelector("#pauseBadge"),
      viewport: document.querySelector("#viewport"),
      renderControls: document.querySelector("#renderControls"),
      materialList: document.querySelector("#materialList"),
      materialActions: document.querySelector("#materialActions"),
      clearAccumBtn: document.querySelector("#clearAccumBtn"),
      saveBtn: document.querySelector("#saveBtn"),
      storageTitle: document.querySelector("#storageTitle"),
      storageSub: document.querySelector("#storageSub"),
      toastHost: document.querySelector("#toastHost"),
      errorOverlay: document.querySelector("#errorOverlay"),
      errorText: document.querySelector("#errorText"),
      errorClose: document.querySelector("#errorClose"),
    };
    this.bindStaticEvents();
  }

  build(state) {
    this.state = state;
    this.buildRenderControls();
    this.buildMaterialCards();
    this.renderActions();
    this.sync(state);
    this.updateResolutionLabel();
  }

  bindStaticEvents() {
    this.refs.pauseBtn.addEventListener("click", () => this.callbacks.onTogglePause());
    this.refs.hudPauseBtn.addEventListener("click", () => this.callbacks.onTogglePause());
    this.refs.saveBtn.addEventListener("click", () => this.callbacks.onSave());
    this.refs.clearAccumBtn.addEventListener("click", () => this.callbacks.onClearAccum());
    this.refs.errorClose.addEventListener("click", () => this.hideError());
    this.refs.renderControls.addEventListener("input", (event) => this.handleRenderControl(event));
    this.refs.renderControls.addEventListener("click", (event) => this.handleRenderClick(event));
    this.refs.materialList.addEventListener("input", (event) => this.handleMaterialInput(event));
    this.refs.materialList.addEventListener("click", (event) => this.handleMaterialClick(event));
    this.refs.materialList.addEventListener("keydown", (event) => this.handleMaterialKeyDown(event));
    this.refs.materialActions.addEventListener("click", () => this.callbacks.onResetUnlocked());
  }

  buildRenderControls() {
    const state = this.state;
    const sppOptions = [1, 2, 4, 8]
      .map(
        (value) =>
          `<button type="button" data-spp="${value}" aria-pressed="${value === state.render.samplesPerFrame}">${value}</button>`
      )
      .join("");
    const resolutionOptions = RESOLUTIONS.map(
      (item) =>
        `<option value="${item.id}" ${item.id === state.render.resolution ? "selected" : ""}>${item.label}</option>`
    ).join("");

    this.refs.renderControls.innerHTML = `
      <div class="control">
        <div class="control-head"><span>每帧采样</span><span class="control-value" data-render-value="spp">${state.render.samplesPerFrame} spp</span></div>
        <div class="segmented">${sppOptions}</div>
      </div>
      <div class="control">
        <label class="control-head" for="bounceRange"><span>最大弹射</span><span class="control-value" data-render-value="bounce">${state.render.maxBounces}</span></label>
        <input class="range" id="bounceRange" data-render="maxBounces" type="range" min="3" max="12" step="1" value="${state.render.maxBounces}">
      </div>
      <div class="control">
        <label class="control-head" for="exposureRange"><span>曝光</span><span class="control-value" data-render-value="exposure">${this.formatExposure(state.render.exposure)}</span></label>
        <input class="range" id="exposureRange" data-render="exposure" type="range" min="-2.5" max="2.5" step="0.1" value="${state.render.exposure}">
      </div>
      <div class="control">
        <label class="control-head" for="resolutionSelect"><span>视口分辨率</span><span class="control-value">渐进缓冲</span></label>
        <select class="select-field" id="resolutionSelect" data-render="resolution">${resolutionOptions}</select>
      </div>
      <div class="control">
        <div class="switch-row">
          <div><span>相机移动重投影</span><small>移动时保留旧样本并逐帧替换</small></div>
          <button class="switch" type="button" data-history-toggle role="switch" aria-checked="${state.render.historyReprojection}">
            <span></span>
          </button>
        </div>
      </div>
    `;
  }

  buildMaterialCards() {
    const state = this.state;
    this.refs.materialList.innerHTML = MATERIAL_KEYS.map((key) => {
      const meta = MATERIAL_META[key];
      const material = state.materials[key];
      const locked = state.locks[key];
      const selected = key === this.selectedMaterial;
      const controls = MATERIAL_CONTROLS[key]
        .map(
          (control) => `
          <div class="control">
            <label class="control-head" for="${key}-${control.prop}"><span>${control.label}</span><span class="control-value" data-material-value="${key}.${control.prop}">${control.format(material[control.prop])}</span></label>
            <input class="range" id="${key}-${control.prop}" data-material="${key}" data-prop="${control.prop}" type="range" min="${control.min}" max="${control.max}" step="${control.step}" value="${material[control.prop]}">
          </div>`
        )
        .join("");
      return `
        <div class="material-card" data-material-card="${key}" data-locked="${locked}" data-selected="${selected}">
          <div class="material-head">
            <span class="material-icon" data-select="${key}">${iconMarkup(meta.icon)}</span>
            <span class="material-copy" data-select="${key}" role="button" tabindex="0" aria-expanded="${selected}">
              <span class="material-name">${meta.name}<span class="material-swatch" data-swatch="${key}" style="background:${material.color}"></span></span>
              <span class="material-sub">${meta.sub}</span>
            </span>
            <button class="lock-btn" type="button" data-lock="${key}" aria-pressed="${locked}" aria-label="${locked ? "解锁" : "锁定"}${meta.name}材质" title="${locked ? "已锁定：批量重置时保留" : "锁定后批量重置不会覆盖该材质"}">${iconMarkup(locked ? "lock" : "unlock")}</button>
          </div>
          <div class="material-controls">
            <div class="color-control">
              <span>颜色</span>
              <label class="color-field">
                <input type="color" data-material="${key}" data-prop="color" value="${material.color}" aria-label="${meta.name}颜色">
                <code data-material-value="${key}.color">${material.color.toUpperCase()}</code>
              </label>
            </div>
            ${controls}
          </div>
        </div>
      `;
    }).join("");
  }

  renderActions() {
    this.refs.materialActions.innerHTML = `
      <button class="btn btn-quiet" type="button" data-reset-unlocked>
        ${iconMarkup("refresh")}<span>重置未锁定材质</span>
      </button>
    `;
  }

  handleRenderClick(event) {
    const sppButton = event.target.closest("[data-spp]");
    if (sppButton) {
      const value = Number(sppButton.dataset.spp);
      this.state.render.samplesPerFrame = value;
      this.refs.renderControls.querySelectorAll("[data-spp]").forEach((button) => {
        button.setAttribute("aria-pressed", String(Number(button.dataset.spp) === value));
      });
      this.setRenderValue("spp", `${value} spp`);
      this.callbacks.onRenderChange("samplesPerFrame", value);
      return;
    }
    const historyButton = event.target.closest("[data-history-toggle]");
    if (historyButton) {
      const enabled = historyButton.getAttribute("aria-checked") !== "true";
      historyButton.setAttribute("aria-checked", String(enabled));
      this.state.render.historyReprojection = enabled;
      this.callbacks.onRenderChange("historyReprojection", enabled);
      this.setHistory(enabled, false);
    }
  }

  handleRenderControl(event) {
    const target = event.target.closest("[data-render]");
    if (!target) return;
    const field = target.dataset.render;
    if (field === "resolution") {
      this.state.render.resolution = target.value;
      this.updateResolutionLabel();
      this.callbacks.onRenderChange("resolution", target.value);
      return;
    }
    if (field === "maxBounces") {
      const value = Number(target.value);
      this.state.render.maxBounces = value;
      this.setRenderValue("bounce", String(value));
      this.callbacks.onRenderChange("maxBounces", value);
      return;
    }
    if (field === "exposure") {
      const value = Number(target.value);
      this.state.render.exposure = value;
      this.setRenderValue("exposure", this.formatExposure(value));
      this.callbacks.onRenderChange("exposure", value);
    }
  }

  handleMaterialClick(event) {
    const lockButton = event.target.closest("[data-lock]");
    if (lockButton) {
      const key = lockButton.dataset.lock;
      const locked = lockButton.getAttribute("aria-pressed") !== "true";
      lockButton.setAttribute("aria-pressed", String(locked));
      lockButton.innerHTML = iconMarkup(locked ? "lock" : "unlock");
      lockButton.setAttribute("aria-label", `${locked ? "解锁" : "锁定"}${MATERIAL_META[key].name}材质`);
      lockButton.title = locked ? "已锁定：批量重置时保留" : "锁定后批量重置不会覆盖该材质";
      const card = this.refs.materialList.querySelector(`[data-material-card="${key}"]`);
      if (card) card.dataset.locked = String(locked);
      this.state.locks[key] = locked;
      this.callbacks.onLockChange(key, locked);
      this.toast(`${MATERIAL_META[key].name}材质已${locked ? "锁定" : "解锁"}`, "success");
      return;
    }
    const selectTarget = event.target.closest("[data-select]");
    if (selectTarget) {
      const key = selectTarget.dataset.select;
      this.selectMaterial(key === this.selectedMaterial ? null : key);
    }
  }

  handleMaterialKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("[data-select]")) return;
    event.preventDefault();
    event.stopPropagation();
    const key = event.target.closest("[data-select]").dataset.select;
    this.selectMaterial(key === this.selectedMaterial ? null : key);
  }

  selectMaterial(key) {
    this.selectedMaterial = key;
    this.refs.materialList.querySelectorAll("[data-material-card]").forEach((card) => {
      const selected = card.dataset.materialCard === key;
      card.dataset.selected = String(selected);
      const copy = card.querySelector("[data-select]");
      if (copy) copy.setAttribute("aria-expanded", String(selected));
    });
  }

  handleMaterialInput(event) {
    const target = event.target.closest("[data-material][data-prop]");
    if (!target) return;
    const key = target.dataset.material;
    const prop = target.dataset.prop;
    const value = prop === "color" ? target.value : Number(target.value);
    this.state.materials[key][prop] = value;
    const label = this.refs.materialList.querySelector(`[data-material-value="${key}.${prop}"]`);
    if (label) {
      if (prop === "color") label.textContent = String(value).toUpperCase();
      else {
        const definition = MATERIAL_CONTROLS[key].find((item) => item.prop === prop);
        label.textContent = definition ? definition.format(value) : String(value);
      }
    }
    if (prop === "color") {
      const swatch = this.refs.materialList.querySelector(`[data-swatch="${key}"]`);
      if (swatch) swatch.style.background = value;
    }
    this.callbacks.onMaterialChange(key, prop, value);
  }

  setRenderValue(key, value) {
    const label = this.refs.renderControls.querySelector(`[data-render-value="${key}"]`);
    if (label) label.textContent = value;
  }

  formatExposure(value) {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)} EV`;
  }

  sync(state) {
    this.state = state;
    if (!this.refs.renderControls.childElementCount) return;
    this.refs.renderControls.querySelectorAll("[data-spp]").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.spp) === state.render.samplesPerFrame));
    });
    this.setRenderValue("spp", `${state.render.samplesPerFrame} spp`);
    const bounceRange = this.refs.renderControls.querySelector('[data-render="maxBounces"]');
    if (bounceRange) bounceRange.value = String(state.render.maxBounces);
    this.setRenderValue("bounce", String(state.render.maxBounces));
    const exposureRange = this.refs.renderControls.querySelector('[data-render="exposure"]');
    if (exposureRange) exposureRange.value = String(state.render.exposure);
    this.setRenderValue("exposure", this.formatExposure(state.render.exposure));
    const resolutionSelect = this.refs.renderControls.querySelector('[data-render="resolution"]');
    if (resolutionSelect) resolutionSelect.value = state.render.resolution;
    const historyButton = this.refs.renderControls.querySelector("[data-history-toggle]");
    if (historyButton) historyButton.setAttribute("aria-checked", String(state.render.historyReprojection));

    for (const key of MATERIAL_KEYS) {
      const card = this.refs.materialList.querySelector(`[data-material-card="${key}"]`);
      if (!card) continue;
      card.dataset.locked = String(state.locks[key]);
      const lockButton = card.querySelector("[data-lock]");
      if (lockButton) {
        lockButton.setAttribute("aria-pressed", String(state.locks[key]));
        lockButton.innerHTML = iconMarkup(state.locks[key] ? "lock" : "unlock");
        lockButton.setAttribute(
          "aria-label",
          `${state.locks[key] ? "解锁" : "锁定"}${MATERIAL_META[key].name}材质`
        );
        lockButton.title = state.locks[key] ? "已锁定：批量重置时保留" : "锁定后批量重置不会覆盖该材质";
      }
      card.querySelectorAll("[data-material][data-prop]").forEach((input) => {
        const prop = input.dataset.prop;
        const value = state.materials[key][prop];
        input.value = String(value);
        const label = card.querySelector(`[data-material-value="${key}.${prop}"]`);
        if (label) {
          if (prop === "color") label.textContent = value.toUpperCase();
          else {
            const definition = MATERIAL_CONTROLS[key].find((item) => item.prop === prop);
            if (definition) label.textContent = definition.format(value);
          }
        }
        if (prop === "color") {
          const swatch = card.querySelector(`[data-swatch="${key}"]`);
          if (swatch) swatch.style.background = value;
        }
      });
    }
    this.updateResolutionLabel();
    this.setHistory(state.render.historyReprojection, false);
  }

  updateResolutionLabel() {
    if (!this.state) return;
    const resolution = resolutionInfo(this.state);
    this.refs.renderTag.textContent = resolution.label;
  }

  setStats(stats) {
    const spp = Math.max(0, Math.round(stats.spp));
    this.refs.sppValue.textContent = numberFormat(spp);
    const progress = Math.min(100, (spp / this.sppTarget) * 100);
    this.refs.progressBar.style.width = `${progress.toFixed(1)}%`;
    this.refs.sppRate.textContent = stats.rate;
    this.refs.fpsValue.textContent = stats.fps > 0 ? `${Math.round(stats.fps)} fps` : "-- fps";
    this.setHistory(stats.historyActive, stats.cameraMoving);
  }

  setHistory(active, moving) {
    this.refs.historyState.dataset.active = String(active);
    this.refs.historyState.innerHTML = `<span class="dot"></span>${active ? (moving ? "重投影重建中" : "历史重投影开启") : "相机移动将重置"}`;
  }

  setPaused(paused) {
    this.paused = paused;
    this.refs.pauseBadge.hidden = !paused;
    this.refs.viewport.classList.toggle("is-paused", paused);
    this.refs.pauseLabel.textContent = paused ? "恢复采样" : "暂停采样";
    this.refs.pauseBtn.dataset.icon = paused ? "play" : "pause";
    this.refs.hudPauseBtn.dataset.icon = paused ? "play" : "pause";
    this.refs.hudPauseBtn.setAttribute("aria-label", paused ? "恢复采样" : "暂停采样");
    const pauseIcon = this.refs.pauseBtn.querySelector("svg");
    if (pauseIcon) pauseIcon.outerHTML = iconMarkup(paused ? "play" : "pause");
    const hudIcon = this.refs.hudPauseBtn.querySelector("svg");
    if (hudIcon) hudIcon.outerHTML = iconMarkup(paused ? "play" : "pause");
    if (paused) {
      this.refs.sppRate.textContent = "已暂停";
    }
  }

  setSaveStatus(status, details) {
    const labels = {
      idle: "未保存",
      dirty: "等待保存",
      saving: "保存中",
      saved: "已保存",
      error: "保存失败",
    };
    this.refs.saveState.textContent = labels[status] || "未保存";
    this.refs.saveState.dataset.state = status;
    if (status === "saved") {
      this.lastSave = details && details.savedAt ? new Date(details.savedAt) : new Date();
      this.refs.storageTitle.textContent = "自动保存已开启";
      this.refs.storageSub.textContent = `上次保存 ${formatTime(this.lastSave)} · ${numberFormat(details.spp)} spp`;
    } else if (status === "saving") {
      this.refs.storageSub.textContent = "正在写入累积缓冲";
    } else if (status === "error") {
      this.refs.storageTitle.textContent = "自动保存失败";
      this.refs.storageSub.textContent = details && details.message ? details.message : "无法写入本地存储";
    } else if (status === "dirty") {
      this.refs.storageSub.textContent = "有新的采样等待写入";
    }
  }

  setGpuState(state, label) {
    this.refs.gpuPill.dataset.state = state;
    this.refs.gpuLabel.textContent = label;
  }

  toast(message, type = "info") {
    const icon = type === "success" ? "check" : type === "error" ? "warning" : "info";
    const element = document.createElement("div");
    element.className = `toast is-${type}`;
    element.innerHTML = iconMarkup(icon);
    const label = document.createElement("span");
    label.textContent = message;
    element.append(label);
    this.refs.toastHost.append(element);
    window.setTimeout(() => {
      element.style.opacity = "0";
      element.style.transform = "translateY(4px)";
      element.style.transition = "opacity .2s, transform .2s";
      window.setTimeout(() => element.remove(), 220);
    }, type === "error" ? 5200 : 2800);
  }

  showError(message) {
    this.refs.errorText.textContent = message;
    this.refs.errorOverlay.hidden = false;
  }

  hideError() {
    this.refs.errorOverlay.hidden = true;
  }
}
